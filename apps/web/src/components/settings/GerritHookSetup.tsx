import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

export function GerritHookSetup({
  environmentId,
  cwd,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}) {
  const diagnosis = useEnvironmentQuery(
    sourceControlEnvironment.gerritHook({ environmentId, input: { cwd } }),
  );
  const install = useAtomCommand(sourceControlEnvironment.gerritInstallHook, {
    reportFailure: true,
  });
  const canInstall = useAtomValue(
    sourceControlEnvironment.gerritInstallHook.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  return (
    <section aria-label="Change-Id hook" className="grid gap-2">
      <h3 className="text-sm font-medium">Change-Id hook</h3>
      {diagnosis.error ? <p role="alert">{diagnosis.error}</p> : null}
      {diagnosis.data ? (
        <>
          <p className="break-all text-xs">
            {diagnosis.data.state} · {diagnosis.data.destination}
          </p>
          <p className="text-xs">{diagnosis.data.issues.join(" · ")}</p>
          {diagnosis.data.state === "missing" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!canInstall || busy}
              onClick={async () => {
                setBusy(true);
                const result = await install({ environmentId, input: { cwd } });
                if (result._tag === "Success") diagnosis.refresh();
                setBusy(false);
              }}
            >
              Install hook
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
