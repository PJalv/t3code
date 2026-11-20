import { T, useGT } from "gt-react";
import {
  GerritTargetBranch,
  type EnvironmentId,
  type GerritChangeRevision,
  type ThreadId,
  type GerritUploadCommitResult,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useEffectEvent, useId, useState } from "react";
import { buildGerritUploadInput } from "~/components/GitActionsControl.logic";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { vcsEnvironment } from "~/state/vcs";

type UploadResult = typeof GerritUploadCommitResult.Type;

export function GerritDeliveryDialog({
  open,
  onOpenChange,
  environmentId,
  cwd,
  canWrite,
  expectedChange = null,
  threadId,
  onCompleted,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly canWrite: boolean;
  readonly expectedChange?: GerritChangeRevision | null;
  readonly onCompleted: () => void;
  readonly threadId?: ThreadId;
}) {
  const gt = useGT();
  const [targetBranch, setTargetBranch] = useState("");
  const [topic, setTopic] = useState("");
  const [reviewers, setReviewers] = useState("");
  const [cc, setCc] = useState("");
  const [wip, setWip] = useState(false);
  const [privateChange, setPrivateChange] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const id = useId();
  const contextQuery = useEnvironmentQuery(
    open && environmentId !== null && cwd !== null
      ? sourceControlEnvironment.gerritDeliveryCheckout({
          environmentId,
          input: {
            cwd,
            ...(targetBranch.trim()
              ? { targetBranch: GerritTargetBranch.make(targetBranch.trim()) }
              : {}),
          },
        })
      : null,
  );
  const revalidateContext = useEffectEvent(() => {
    if (contextQuery.data !== null) contextQuery.refresh();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refresh the server checkout when the dialog opens
  useEffect(() => {
    if (open) revalidateContext();
  }, [open]);
  const context = contextQuery.data;
  const ready = context?.kind === "ready" || context?.kind === "new-change" ? context : null;
  const mismatch =
    expectedChange !== null &&
    ready !== null &&
    (ready.kind !== "ready" ||
      ready.change.number !== expectedChange.number ||
      ready.change.key.installation !== expectedChange.key.installation ||
      ready.change.key.project !== expectedChange.key.project ||
      ready.change.key.branch !== expectedChange.key.branch ||
      ready.change.key.changeId !== expectedChange.key.changeId);
  const topicValue = topic.trim();
  const topicValid =
    topicValue.length <= 1024 && !topicValue.startsWith("-") && !/[\s\0%,]/.test(topicValue);
  const sameCommit = ready?.kind === "ready" && ready.head === ready.change.revision.commit;
  const upload = useAtomCommand(pullRequestEnvironment.gerritUploadCommit, {
    reportFailure: false,
  });
  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const invalidate = useAtomCommand(pullRequestEnvironment.invalidate, { reportFailure: false });
  const canUploadDirect = useAtomValue(
    pullRequestEnvironment.gerritUploadCommit.permissionAtom(environmentId),
  );
  const canUpload =
    canWrite &&
    canUploadDirect &&
    environmentId !== null &&
    cwd !== null &&
    ready !== null &&
    !mismatch &&
    !contextQuery.isPending &&
    !contextQuery.error &&
    topicValid &&
    ready.files.length === 0 &&
    !sameCommit &&
    !busy &&
    result === null;
  const submit = async () => {
    if (!canUpload || environmentId === null || cwd === null || ready === null) return;
    setBusy(true);
    setError(null);
    const response = await upload({
      environmentId,
      input: {
        cwd,
        ...(threadId !== undefined ? { threadId } : {}),
        upload: buildGerritUploadInput(ready, {
          branch: targetBranch,
          topic,
          reviewers,
          cc,
          wip,
          private: privateChange,
        }),
      },
    });
    if (response._tag === "Success") {
      setResult(response.value);
      const [statusRefresh, pullRequestRefresh] = await Promise.all([
        refreshStatus({ environmentId, input: { cwd } }),
        invalidate({ environmentId, input: {} }),
      ]);
      if (statusRefresh._tag !== "Success" || pullRequestRefresh._tag !== "Success") {
        setError(gt("Upload succeeded, but git status or reviews could not be refreshed."));
      }
    } else {
      const cause = squashAtomCommandFailure(response);
      setError(cause instanceof Error ? cause.message : gt("Could not upload the commit."));
    }
    setBusy(false);
  };
  const close = () => {
    if (result !== null) onCompleted();
    setTargetBranch("");
    setTopic("");
    setReviewers("");
    setCc("");
    setWip(false);
    setPrivateChange(false);
    setError(null);
    setResult(null);
    onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) close();
        else if (next) onOpenChange(true);
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            <T>Upload commit for review</T>
          </DialogTitle>
          <DialogDescription>
            <T>Upload HEAD as a new change or patch set to Gerrit.</T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3">
            {ready?.kind !== "ready" && expectedChange === null && result === null ? (
              <div className="grid gap-1">
                <Label htmlFor={`${id}-branch`}>
                  <T>Destination branch for a new change</T>
                </Label>
                <Input
                  id={`${id}-branch`}
                  value={targetBranch}
                  disabled={busy}
                  onChange={(event) => setTargetBranch(event.target.value)}
                  placeholder={gt("Configured branch")}
                />
              </div>
            ) : null}
            {contextQuery.error ? (
              <p role="alert" className="text-sm text-destructive">
                {contextQuery.error}
              </p>
            ) : context === null ? (
              <p role="status" className="text-sm text-muted-foreground">
                <T>Reading checkout context…</T>
              </p>
            ) : ready === null ? (
              <p role="alert" className="text-sm text-warning">
                {context.kind === "blocked" || context.kind === "not-bound"
                  ? context.detail
                  : gt("Checkout unavailable.")}
              </p>
            ) : (
              <>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg bg-card p-3 text-sm">
                  <dt>
                    <T>Local branch</T>
                  </dt>
                  <dd className="font-mono">{ready.localBranch}</dd>
                  <dt>
                    <T>HEAD</T>
                  </dt>
                  <dd>
                    <span className="font-mono">{ready.head.slice(0, 12)}</span> · {ready.subject}
                  </dd>
                  <dt>
                    <T>Change-Id</T>
                  </dt>
                  <dd className="break-all font-mono">
                    {ready.kind === "ready" ? ready.change.key.changeId : ready.key.changeId}
                  </dd>
                  <dt>
                    <T>Target</T>
                  </dt>
                  <dd>
                    {ready.kind === "ready"
                      ? `${ready.change.key.project} #${ready.change.number} · ${ready.change.key.branch}`
                      : gt("New change · {branch}", { branch: ready.key.branch })}
                  </dd>
                </dl>
                {mismatch ? (
                  <p role="alert" className="text-sm text-warning">
                    <T>
                      HEAD does not match the selected Gerrit change. Open the checkout for that
                      change.
                    </T>
                  </p>
                ) : null}
                {ready.files.length > 0 ? (
                  <p role="alert" className="text-sm text-warning">
                    {gt(
                      "The checkout has {count, plural, one {{count} uncommitted file} other {{count} uncommitted files}}. Commit or stash the changes before uploading.",
                      { count: ready.files.length },
                    )}
                  </p>
                ) : sameCommit && ready.kind === "ready" ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    {gt(
                      "HEAD is already patch set {patchSet} of #{number}. Amend or add a commit to upload a new patch set.",
                      { patchSet: ready.change.revision.patchSet, number: ready.change.number },
                    )}
                  </p>
                ) : null}
              </>
            )}
            {result === null ? (
              <>
                <div className="grid gap-1">
                  <Label htmlFor={`${id}-topic`}>
                    <T>Topic (optional)</T>
                  </Label>
                  <Input
                    id={`${id}-topic`}
                    value={topic}
                    disabled={busy}
                    maxLength={1024}
                    onChange={(event) => setTopic(event.target.value)}
                  />
                  <p
                    className={
                      topicValid ? "text-xs text-muted-foreground" : "text-xs text-warning"
                    }
                  >
                    <T>Topics cannot contain whitespace, % or , or start with -.</T>
                  </p>
                </div>
                <div className="grid gap-1">
                  <Label htmlFor={`${id}-reviewers`}>
                    <T>Reviewers (optional)</T>
                  </Label>
                  <Input
                    id={`${id}-reviewers`}
                    value={reviewers}
                    disabled={busy}
                    onChange={(event) => setReviewers(event.target.value)}
                    placeholder={gt("Accounts or email addresses, separated by commas")}
                  />
                </div>
                <div className="grid gap-1">
                  <Label htmlFor={`${id}-cc`}>
                    <T>CC (optional)</T>
                  </Label>
                  <Input
                    id={`${id}-cc`}
                    value={cc}
                    disabled={busy}
                    onChange={(event) => setCc(event.target.value)}
                    placeholder={gt("Accounts or email addresses, separated by commas")}
                  />
                </div>
                <div className="flex flex-wrap gap-4">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={`${id}-wip`}
                      checked={wip}
                      disabled={busy}
                      onCheckedChange={(checked) => setWip(checked === true)}
                    />
                    <Label htmlFor={`${id}-wip`}>
                      <T>Mark work in progress</T>
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={`${id}-private`}
                      checked={privateChange}
                      disabled={busy}
                      onCheckedChange={(checked) => setPrivateChange(checked === true)}
                    />
                    <Label htmlFor={`${id}-private`}>
                      <T>Mark private</T>
                    </Label>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  <T>Unchecked options leave existing WIP and private flags unchanged.</T>
                </p>
              </>
            ) : (
              <div role="status" className="text-sm">
                <p>
                  {gt("Upload complete.")}
                  {(result.result.changeNumber ?? result.change?.number)
                    ? gt(" Change #{number}", {
                        number: result.result.changeNumber ?? result.change?.number,
                      })
                    : null}
                  {(result.result.patchSet ?? result.change?.currentPatchSet)
                    ? gt(" Patch set {number}", {
                        number: result.result.patchSet ?? result.change?.currentPatchSet,
                      })
                    : null}
                </p>
                {result.result.url ? (
                  <a
                    href={result.result.url}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    <T>Open change</T>
                  </a>
                ) : null}
                {result.rereadError ? <p>{result.rereadError}</p> : null}
                {result.linkError ? <p>{result.linkError}</p> : null}
              </div>
            )}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" size="sm" onClick={close} disabled={busy}>
            {result ? gt("Done", { $context: "dismiss dialog, verb" }) : gt("Cancel")}
          </Button>
          {result === null ? (
            <Button size="sm" onClick={() => void submit()} disabled={!canUpload}>
              {busy
                ? gt("Uploading…")
                : gt("Upload", { $context: "upload a commit for Gerrit review, verb" })}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
