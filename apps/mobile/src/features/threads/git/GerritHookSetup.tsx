import { T, useGT } from "gt-react-native";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { useEnvironmentQuery } from "../../../state/query";
import { sourceControlEnvironment } from "../../../state/sourceControl";
import { useAtomCommand } from "../../../state/use-atom-command";

export function GerritHookSetup({
  environmentId,
  cwd,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}) {
  const gt = useGT();
  const diagnosis = useEnvironmentQuery(
    sourceControlEnvironment.gerritHook({ environmentId, input: { cwd } }),
  );
  const install = useAtomCommand(sourceControlEnvironment.gerritInstallHook);
  const canInstall = useAtomValue(
    sourceControlEnvironment.gerritInstallHook.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <View accessibilityLabel={gt("Change-Id hook")} className="gap-2">
      <Text>
        <T>Change-Id hook</T>
      </Text>
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      {diagnosis.error ? <Text accessibilityRole="alert">{diagnosis.error}</Text> : null}
      {diagnosis.data ? (
        <>
          <Text>
            {diagnosis.data.state} · {diagnosis.data.destination}
          </Text>
          <Text>{diagnosis.data.issues.join(" · ")}</Text>
          {diagnosis.data.state === "missing" ? (
            <Button
              label={gt("Install hook")}
              disabled={!canInstall || busy}
              onPress={async () => {
                setBusy(true);
                setError(null);
                const result = await install({ environmentId, input: { cwd } });
                if (result._tag === "Success") diagnosis.refresh();
                else setError(gt("Could not install the hook. Try again."));
                setBusy(false);
              }}
            />
          ) : null}
        </>
      ) : null}
    </View>
  );
}
