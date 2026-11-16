import { useAtomValue } from "@effect/atom-react";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { GerritVotePicker } from "./PullRequestGerritSummary";
import { capitalizeTerm } from "@t3tools/client-runtime/source-control-clients";
import type { EnvironmentId, PullRequestRef, PullRequestReviewVerdict } from "@t3tools/contracts";
import { CheckIcon, MessageSquareIcon, XCircleIcon } from "lucide-react";
import { msg, useGT, useMessages } from "gt-react";
import { useEffect, useState, type ReactNode, type RefObject } from "react";

import { m } from "~/i18n/messages";

import { TextFieldSpeechControls, useTextFieldSpeech } from "~/speech/useTextFieldSpeech";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { isCommentSubmitShortcut } from "../diffs/commentSubmitShortcut";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger } from "../ui/select";
import { toastManager } from "../ui/toast";
import { readableFailure } from "./pullRequestDetail.logic";
import {
  pullRequestReviewKey,
  usePendingReviewComments,
  usePullRequestReviewStore,
} from "./pullRequestReviewStore";
import {
  PullRequestMarkdownTextarea,
  type PullRequestCompletionScope,
} from "./PullRequestMarkdownTextarea";

import type { ChangeRequestTermKind } from "./changeRequestTerm";

const VERDICTS: ReadonlyArray<{
  readonly value: PullRequestReviewVerdict;
  readonly label: string;
  readonly sent: (term: ChangeRequestTermKind) => string;
  readonly icon: ReactNode;
}> = [
  {
    value: "comment",
    label: msg("Comment", { $context: "review verdict" }),
    sent: () => m(msg("Review submitted")),
    icon: <MessageSquareIcon className="size-3" />,
  },
  {
    value: "approve",
    label: msg("Approve", { $context: "review verdict" }),
    sent: (term) =>
      m(
        msg(
          "{term, select, mr {Merge request} cr {Change request} other {Pull request}} approved",
          { term },
        ),
      ),
    icon: <CheckIcon className="size-3" />,
  },
  {
    value: "request-changes",
    label: msg("Request changes"),
    sent: () => m(msg("Changes requested")),
    icon: <XCircleIcon className="size-3" />,
  },
];

export function PullRequestReviewForm({
  environmentId,
  active,
  reference,
  completionScope,
  term,
  verdicts,
  requestChangesSummaryRequired,
  textareaRef,
  pending,
  onPendingChange,
  onSubmitted,
}: {
  environmentId: EnvironmentId;
  /** False while the form stays mounted but hidden; dictation is cancelled then. */
  active: boolean;
  reference: PullRequestRef;
  completionScope: PullRequestCompletionScope | null;
  term: ChangeRequestTermKind;
  verdicts: ReadonlyArray<PullRequestReviewVerdict>;
  requestChangesSummaryRequired: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  pending: boolean;
  onPendingChange: (pending: boolean) => void;
  onSubmitted: () => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const [requestedVerdict, setRequestedVerdict] = useState<PullRequestReviewVerdict>("comment");
  const [voteState, setVoteState] = useState<{ key: string; votes: Record<string, string> }>({
    key: "",
    votes: {},
  });
  const referenceKey = `${environmentId}:${reference.projectId}:${reference.host ?? ""}:${reference.repository}:${reference.number}`;
  const votes = voteState.key === referenceKey ? voteState.votes : {};
  const detail = useEnvironmentQuery(
    pullRequestEnvironment.detail({ environmentId, input: reference }),
  ).data;
  const canVote = useAtomValue(pullRequestEnvironment.gerritCommand.permissionAtom(environmentId));
  const setVotes = useAtomCommand(pullRequestEnvironment.gerritCommand, { reportFailure: false });
  const comments = usePendingReviewComments(reference);
  const reviewKey = pullRequestReviewKey(reference);
  const body = usePullRequestReviewStore((store) => store.summaries[reviewKey] ?? "");
  const removeComments = usePullRequestReviewStore((store) => store.removeComments);
  const setSummary = usePullRequestReviewStore((store) => store.setSummary);
  const speech = useTextFieldSpeech({
    environmentId,
    projectId: reference.projectId,
    ownerKey: JSON.stringify(["pr-review", environmentId, reviewKey]),
    text: body,
    textareaRef,
    onTextChange: (text) => setSummary(reviewKey, text),
    disabled: !active || pending,
  });
  const { cancel } = speech;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- discards a recording when the hidden form can no longer be submitted
  useEffect(() => {
    if (!active) cancel();
  }, [active, cancel]);
  const clearSummary = usePullRequestReviewStore((store) => store.clearSummary);
  const submitReview = useAtomCommand(pullRequestEnvironment.submitReview, {
    reportFailure: false,
  });

  const offered = VERDICTS.filter((verdict) => verdicts.includes(verdict.value));
  const selectedVerdict =
    offered.find((verdict) => verdict.value === requestedVerdict) ?? offered[0];

  const submit = async (verdict: (typeof VERDICTS)[number], text: string) => {
    const submittedComments = usePullRequestReviewStore.getState().drafts[reviewKey] ?? [];
    if (pending || !canSubmit(verdict.value, text, submittedComments.length)) return;
    const submittedBody = text;
    onPendingChange(true);
    const voteOnly =
      verdict.value === "comment" && !submittedBody.trim() && submittedComments.length === 0;
    const result = voteOnly
      ? null
      : await submitReview({
          environmentId,
          input: {
            ...reference,
            verdict: verdict.value,
            body: submittedBody,
            comments: submittedComments,
          },
        });
    if (result?._tag === "Failure") {
      onPendingChange(false);
      toastManager.add({
        type: "error",
        title: m(msg("The review could not be submitted")),
        description: readableFailure(
          squashAtomCommandFailure(result),
          m(msg("The host refused the review. Your draft is still here to try again.")),
        ),
      });
      return;
    }
    // Preserve comments and summary edits made during submission.
    removeComments(
      reviewKey,
      submittedComments.map((comment) => comment.id),
    );
    clearSummary(reviewKey, submittedBody);
    const selectedVotes = Object.fromEntries(
      (detail?.gerrit?.labels ?? []).flatMap((label) => {
        const selected = votes[label.name];
        return canVote &&
          selected !== undefined &&
          label.permittedValues.includes(Number(selected)) &&
          !(label.name === "Code-Review" && verdict.value !== "comment")
          ? [[label.name, Number(selected)]]
          : [];
      }),
    );
    if (Object.keys(selectedVotes).length > 0) {
      const voteResult = await setVotes({
        environmentId,
        input: { ...reference, command: "setVotes", payload: { votes: selectedVotes } },
      });
      if (voteResult._tag === "Failure") {
        onPendingChange(false);
        toastManager.add({
          type: "error",
          title: voteOnly
            ? "Votes could not be set"
            : "Review submitted, but votes could not be set",
        });
        if (!voteOnly) onSubmitted();
        return;
      }
    }
    setVoteState({ key: referenceKey, votes: {} });
    onPendingChange(false);
    toastManager.add({ type: "success", title: verdict.sent(term) });
    onSubmitted();
  };

  // Forgejo requires a summary when requesting changes, even with inline comments.
  const canSubmit = (verdict: PullRequestReviewVerdict, summary: string, commentCount: number) =>
    verdict === "request-changes" && requestChangesSummaryRequired
      ? summary.trim().length > 0
      : verdict === "approve" ||
        summary.trim().length > 0 ||
        commentCount > 0 ||
        (canVote &&
          (detail?.gerrit?.labels ?? []).some(
            (label) =>
              votes[label.name] !== undefined &&
              label.permittedValues.includes(Number(votes[label.name])) &&
              !(label.name === "Code-Review" && verdict !== "comment"),
          ));
  const placeholder =
    selectedVerdict === undefined || canSubmit(selectedVerdict.value, "", comments.length)
      ? gt("Summarize your review (optional)")
      : selectedVerdict.value === "request-changes" && requestChangesSummaryRequired
        ? gt("Summarize your review (required to request changes)")
        : gt("Summarize your review or add line comments");

  return (
    <>
      <PullRequestMarkdownTextarea
        ref={textareaRef}
        completionScope={completionScope}
        rows={3}
        readOnly={speech.freezesEditor}
        value={body}
        placeholder={placeholder}
        aria-label={gt("Review summary")}
        onValueChange={(next) => setSummary(reviewKey, next)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229 || event.repeat) return;
          if (
            selectedVerdict !== undefined &&
            isCommentSubmitShortcut(event, body, pending || speech.preparing, true)
          ) {
            event.preventDefault();
            event.stopPropagation();
            speech.submitAfterDictation((text) => void submit(selectedVerdict, text));
          }
        }}
      />
      {detail?.gerrit && canVote ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {detail.gerrit.labels.map((label) => (
            <div key={label.name} className="flex items-center gap-1 text-xs">
              <span>{label.name}</span>
              <GerritVotePicker
                label={label}
                value={votes[label.name] ?? null}
                disabled={
                  pending || (label.name === "Code-Review" && selectedVerdict?.value !== "comment")
                }
                onChange={(value) =>
                  setVoteState({ key: referenceKey, votes: { ...votes, [label.name]: value } })
                }
              />
            </div>
          ))}
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        <TextFieldSpeechControls speech={speech} disabled={pending} />
        {offered.length > 1 ? (
          <Select
            value={selectedVerdict?.value ?? null}
            disabled={pending}
            onValueChange={(value) => {
              if (value !== null) setRequestedVerdict(value);
            }}
          >
            <SelectTrigger size="xs" className="w-auto min-w-0" aria-label={gt("Review verdict")}>
              <span className="flex items-center gap-1.5">
                {selectedVerdict?.icon}
                {selectedVerdict ? resolve(selectedVerdict.label) : null}
              </span>
            </SelectTrigger>
            <SelectPopup side="top" alignItemWithTrigger={false}>
              {offered.map((verdict) => (
                <SelectItem key={verdict.value} value={verdict.value}>
                  <span className="flex items-center gap-1.5">
                    {verdict.icon}
                    {resolve(verdict.label)}
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
        <Button
          size="xs"
          disabled={
            speech.preparing ||
            pending ||
            selectedVerdict === undefined ||
            (!canSubmit(selectedVerdict.value, body, comments.length) && !speech.blocksSubmission)
          }
          onClick={() => {
            if (selectedVerdict !== undefined)
              speech.submitAfterDictation((text) => void submit(selectedVerdict, text));
          }}
        >
          {pending ? gt("Submitting...") : gt("Submit review")}
        </Button>
      </div>
    </>
  );
}
