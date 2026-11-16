import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { GerritDeliveryDialog } from "./GerritDeliveryDialog";

const deliveryTargetAtom = Atom.make<{
  environmentId: EnvironmentId;
  cwd: string;
  threadId?: ThreadId;
} | null>(null).pipe(Atom.keepAlive, Atom.withLabel("gerrit:delivery-dialog-target"));

export function openGerritDeliveryDialog(target: {
  environmentId: EnvironmentId;
  cwd: string;
  threadId?: ThreadId;
}): void {
  appAtomRegistry.set(deliveryTargetAtom, target);
}

export function GerritDeliveryDialogHost() {
  const target = useAtomValue(deliveryTargetAtom);
  const environmentId = target?.environmentId ?? null;
  const canWrite = useAtomValue(
    pullRequestEnvironment.gerritUploadCommit.permissionAtom(environmentId),
  );
  if (target === null) return null;
  return (
    <GerritDeliveryDialog
      open
      onOpenChange={(open) => {
        if (!open) appAtomRegistry.set(deliveryTargetAtom, null);
      }}
      environmentId={target.environmentId}
      cwd={target.cwd}
      {...(target.threadId ? { threadId: target.threadId } : {})}
      canWrite={canWrite}
      onCompleted={() => {}}
    />
  );
}
