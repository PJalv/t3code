import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PullRequestDetailView, PullRequestRef } from "@t3tools/contracts";
import { canResolveWithReply } from "@t3tools/client-runtime/pull-request-editing";
import { useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { PullRequestMarkdownEditor } from "./PullRequestMarkdownEditor";
import { pullRequestCompletionScope } from "./PullRequestMarkdownTextarea";

export function PullRequestThreadReply({
  environmentId,
  reference,
  detail,
  thread,
  onRefresh,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
  thread: {
    readonly id: string;
    readonly isResolved: boolean;
    readonly isDraft?: boolean | undefined;
  };
  onRefresh: () => void;
}) {
  const allowed = useAtomValue(pullRequestEnvironment.replyToThread.permissionAtom(environmentId));
  const canResolve = useAtomValue(
    pullRequestEnvironment.setThreadResolution.permissionAtom(environmentId),
  );
  const reply = useAtomCommand(pullRequestEnvironment.replyToThread, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [resolve, setResolve] = useState(false);
  const offerResolve = canResolveWithReply(
    detail,
    thread,
    detail.viewerPermissions.resolve && canResolve,
  );
  if (
    !detail.gerrit ||
    detail.state !== "open" ||
    !detail.capabilities.review.reply ||
    !detail.viewerPermissions.comment ||
    thread.isDraft ||
    !allowed
  )
    return null;

  const send = async (body: string) => {
    if (pending) return;
    setPending(true);
    setError(false);
    const result = await reply({
      environmentId,
      input: {
        ...reference,
        threadId: thread.id,
        body,
        ...(resolve && offerResolve ? { resolve: true } : {}),
      },
    });
    setPending(false);
    if (result._tag === "Failure") {
      setError(true);
      return;
    }
    setOpen(false);
    setResolve(false);
    onRefresh();
  };

  return open ? (
    <div className="mt-2 space-y-2">
      {offerResolve ? (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={resolve} onCheckedChange={setResolve} disabled={pending} />
          Resolve conversation
        </label>
      ) : null}
      <PullRequestMarkdownEditor
        value=""
        cwd={detail.workspaceRoot}
        environmentId={environmentId}
        completionScope={pullRequestCompletionScope(detail, environmentId, reference)}
        label="Reply to this conversation"
        placeholder="Write a reply"
        saving={pending}
        saveLabel="Post reply"
        onSave={(body) => void send(body)}
        onCancel={() => {
          setOpen(false);
          setResolve(false);
        }}
      />
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          Reply could not be posted. Your text is preserved.
        </p>
      ) : null}
    </div>
  ) : (
    <Button
      size="xs"
      variant="ghost"
      onClick={() => {
        setError(false);
        setOpen(true);
      }}
    >
      Reply
    </Button>
  );
}
