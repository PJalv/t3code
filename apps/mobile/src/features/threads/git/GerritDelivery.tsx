import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  GerritTargetBranch,
  type EnvironmentId,
  type GerritUploadCommitResult,
  type ThreadId,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";
import { Switch, TextInput, View } from "react-native";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { useEnvironmentQuery } from "../../../state/query";
import { sourceControlEnvironment } from "../../../state/sourceControl";
import { composerPullRequests } from "../../../state/pull-requests";
import { useAtomCommand } from "../../../state/use-atom-command";
import { vcsEnvironment } from "../../../state/vcs";
import { GerritHookSetup } from "./GerritHookSetup";

type GerritDeliveryProps = {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threadId?: ThreadId;
};

export function GerritDelivery({ environmentId, cwd, threadId }: GerritDeliveryProps) {
  const canWrite = useAtomValue(
    composerPullRequests.gerritUploadCommit.permissionAtom(environmentId),
  );
  const [open, setOpen] = useState(false);
  const [branch, setBranch] = useState("");
  const [topic, setTopic] = useState("");
  const [reviewers, setReviewers] = useState("");
  const [cc, setCc] = useState("");
  const [wip, setWip] = useState(false);
  const [privateChange, setPrivateChange] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<typeof GerritUploadCommitResult.Type | null>(null);
  const checkout = useEnvironmentQuery(
    open
      ? sourceControlEnvironment.gerritDeliveryCheckout({
          environmentId,
          input: {
            cwd,
            ...(branch.trim() ? { targetBranch: GerritTargetBranch.make(branch.trim()) } : {}),
          },
        })
      : null,
  );
  const revalidateCheckout = useEffectEvent(() => {
    if (checkout.data !== null) checkout.refresh();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Refetches the cached checkout each time the sheet opens, since commits may have changed while it was closed.
  useEffect(() => {
    if (open) revalidateCheckout();
  }, [open]);
  const ready =
    checkout.data?.kind === "ready" || checkout.data?.kind === "new-change" ? checkout.data : null;
  const sameCommit = ready?.kind === "ready" && ready.head === ready.change.revision.commit;
  const trimmedTopic = topic.trim();
  const topicValid =
    trimmedTopic.length <= 1024 && !trimmedTopic.startsWith("-") && !/[\s\0%,]/.test(trimmedTopic);
  const canUpload =
    canWrite &&
    ready !== null &&
    !checkout.isPending &&
    !checkout.error &&
    ready.files.length === 0 &&
    !sameCommit &&
    topicValid &&
    !busy &&
    result === null;
  const upload = useAtomCommand(composerPullRequests.gerritUploadCommit, { reportFailure: false });
  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const invalidate = useAtomCommand(composerPullRequests.invalidate, { reportFailure: false });
  const submit = async () => {
    if (!canUpload || ready === null) return;
    setBusy(true);
    setError(null);
    const accounts = (value: string) => value.split(/[\s,]+/).filter(Boolean);
    const reviewerList = accounts(reviewers);
    const ccList = accounts(cc);
    const response = await upload({
      environmentId,
      input: {
        cwd,
        ...(threadId !== undefined ? { threadId } : {}),
        upload: {
          ...(ready.kind === "ready"
            ? { kind: "patch-set" as const, number: ready.change.number }
            : { kind: "new" as const, branch: branch.trim() || ready.key.branch }),
          commit: ready.head,
          ...(trimmedTopic ? { topic: trimmedTopic } : {}),
          ...(reviewerList.length ? { reviewers: reviewerList } : {}),
          ...(ccList.length ? { cc: ccList } : {}),
          ...(wip ? { wip: true } : {}),
          ...(privateChange ? { private: true } : {}),
        },
      },
    });
    if (response._tag === "Success") {
      setResult(response.value);
      const [status, reviews] = await Promise.all([
        refreshStatus({ environmentId, input: { cwd } }),
        invalidate({ environmentId, input: {} }),
      ]);
      if (status._tag !== "Success" || reviews._tag !== "Success")
        setError("Upload succeeded, but git status or reviews could not be refreshed.");
    } else {
      const cause = squashAtomCommandFailure(response);
      setError(cause instanceof Error ? cause.message : "Could not upload the commit.");
    }
    setBusy(false);
  };
  const close = () => {
    setOpen(false);
    setBranch("");
    setTopic("");
    setReviewers("");
    setCc("");
    setWip(false);
    setPrivateChange(false);
    setError(null);
    setResult(null);
  };
  const inputClass = "rounded-lg border border-border-subtle px-3 py-2 text-foreground";
  return (
    <View className="gap-2">
      {!open ? (
        <Button
          label="Upload commit for review"
          disabled={!canWrite}
          onPress={() => setOpen(true)}
        />
      ) : (
        <>
          <Text className="font-semibold">Upload commit for review</Text>
          <Text>Upload HEAD as a new change or patch set to Gerrit.</Text>
          <GerritHookSetup environmentId={environmentId} cwd={cwd} />
          {ready?.kind !== "ready" && result === null ? (
            <>
              <Text>Destination branch for a new change</Text>
              <TextInput
                accessibilityLabel="Destination branch"
                className={inputClass}
                value={branch}
                onChangeText={setBranch}
                editable={!busy}
                placeholder="Configured branch"
              />
            </>
          ) : null}
          {checkout.error ? (
            <Text accessibilityRole="alert">{checkout.error}</Text>
          ) : checkout.data === null ? (
            <Text>Reading checkout context…</Text>
          ) : ready === null ? (
            <Text accessibilityRole="alert">
              {checkout.data.kind === "blocked" || checkout.data.kind === "not-bound"
                ? checkout.data.detail
                : "Checkout unavailable."}
            </Text>
          ) : (
            <>
              <Text>Local branch: {ready.localBranch}</Text>
              <Text selectable>
                HEAD: {ready.head.slice(0, 12)} · {ready.subject}
              </Text>
              <Text selectable>
                Change-Id: {ready.kind === "ready" ? ready.change.key.changeId : ready.key.changeId}
              </Text>
              <Text>
                Target:{" "}
                {ready.kind === "ready"
                  ? `${ready.change.key.project} #${ready.change.number} · ${ready.change.key.branch}`
                  : `New change · ${ready.key.branch}`}
              </Text>
              {ready.files.length > 0 ? (
                <Text accessibilityRole="alert">
                  The checkout has {ready.files.length} uncommitted{" "}
                  {ready.files.length === 1 ? "file" : "files"}. Commit or stash the changes before
                  uploading.
                </Text>
              ) : sameCommit && ready.kind === "ready" ? (
                <Text>
                  HEAD is already patch set {ready.change.revision.patchSet} of #
                  {ready.change.number}. Amend or add a commit to upload a new patch set.
                </Text>
              ) : null}
            </>
          )}
          {result === null ? (
            <>
              <Text>Topic (optional)</Text>
              <TextInput
                accessibilityLabel="Topic"
                className={inputClass}
                value={topic}
                onChangeText={setTopic}
                maxLength={1024}
                editable={!busy}
              />
              <Text>Topics cannot contain whitespace, % or , or start with -.</Text>
              <Text>Reviewers (optional)</Text>
              <TextInput
                accessibilityLabel="Reviewers"
                className={inputClass}
                value={reviewers}
                onChangeText={setReviewers}
                editable={!busy}
                placeholder="Accounts or email addresses, separated by commas"
              />
              <Text>CC (optional)</Text>
              <TextInput
                accessibilityLabel="CC"
                className={inputClass}
                value={cc}
                onChangeText={setCc}
                editable={!busy}
                placeholder="Accounts or email addresses, separated by commas"
              />
              <View className="flex-row items-center gap-2">
                <Switch
                  accessibilityLabel="Mark work in progress"
                  value={wip}
                  onValueChange={setWip}
                  disabled={busy}
                />
                <Text>Mark work in progress</Text>
              </View>
              <View className="flex-row items-center gap-2">
                <Switch
                  accessibilityLabel="Mark private"
                  value={privateChange}
                  onValueChange={setPrivateChange}
                  disabled={busy}
                />
                <Text>Mark private</Text>
              </View>
              <Text>Unchecked options leave existing WIP and private flags unchanged.</Text>
              <Button
                label={busy ? "Uploading…" : "Upload"}
                disabled={!canUpload}
                onPress={() => void submit()}
              />
            </>
          ) : (
            <>
              <Text>
                Upload complete
                {(result.result.changeNumber ?? result.change?.number)
                  ? ` · Change #${result.result.changeNumber ?? result.change?.number}`
                  : ""}
                {(result.result.patchSet ?? result.change?.currentPatchSet)
                  ? ` · Patch set ${result.result.patchSet ?? result.change?.currentPatchSet}`
                  : ""}
                .
              </Text>
              {result.result.url ? <Text selectable>{result.result.url}</Text> : null}
              {result.rereadError ? <Text>{result.rereadError}</Text> : null}
              {result.linkError ? <Text>{result.linkError}</Text> : null}
            </>
          )}
          {error ? <Text accessibilityRole="alert">{error}</Text> : null}
          <Button label={result ? "Done" : "Close"} disabled={busy} onPress={close} />
        </>
      )}
    </View>
  );
}
