import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
} from "@t3tools/contracts";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { TextInput, View } from "react-native";
import { AppText as Text } from "../../../components/ui/AppText";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import type { SettingsTarget } from "../settings-environment-filter";
import { ListActionRow as SettingsActionRow } from "../../../components/ui/ListActionRow";
import {
  appendNewEnvironmentVariables,
  buildEnvironmentVariables,
  environmentEditorSeed,
  parseEnvironmentOverrides,
} from "../lib/acp-environment";

const decodeSettings = Schema.decodeUnknownSync(AcpRegistrySettings);

// These helpers stay at module scope so the component body has no value blocks
// inside its try/catch, which the React Compiler cannot yet compile.
type SaveFields = {
  readonly id: string;
  readonly name: string;
  readonly source: "registry" | "local";
  readonly agentId: string;
  readonly command: string;
  readonly args: string;
  readonly env: string;
};

const acpSettingsInput = (
  existing: ProviderInstanceConfig | undefined,
  source: "registry" | "local",
  agentId: string,
  commandPath: string,
  args: string,
) => ({
  ...(existing?.config && typeof existing.config === "object" ? existing.config : {}),
  source,
  agentId,
  commandPath,
  commandArgs: JSON.parse(args),
});

const mergeEnvironment = (
  existing: ProviderInstanceConfig | undefined,
  env: string,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> => {
  const overrides = parseEnvironmentOverrides(env);
  return appendNewEnvironmentVariables(
    buildEnvironmentVariables(existing?.environment, overrides),
    overrides,
  );
};

const saveResultMessage = (result: { readonly _tag: string }) =>
  result._tag === "Success" ? "Saved." : "Could not save custom command.";

const buildProviderInstanceMutation = (input: {
  readonly existing: ProviderInstanceConfig | undefined;
  readonly fields: SaveFields;
}) => {
  const { existing, fields } = input;
  return {
    operation: existing ? ("upsert" as const) : ("create" as const),
    instanceId: ProviderInstanceId.make(fields.id),
    instance: {
      ...existing,
      driver: ProviderDriverKind.make("acpRegistry"),
      displayName: fields.name.trim(),
      config: decodeSettings(
        acpSettingsInput(existing, fields.source, fields.agentId, fields.command, fields.args),
      ),
      environment: mergeEnvironment(existing, fields.env),
    },
  };
};

export function CustomAcpCommandEditor({ environment }: { readonly environment: SettingsTarget }) {
  const instances = environment.serverConfig.settings.providerInstances;
  const save = useAtomCommand(serverEnvironment.mutateProviderInstance);
  const [id, setId] = useState("acpRegistry_custom");
  const [name, setName] = useState("Custom ACP");
  const [source, setSource] = useState<"registry" | "local">("local");
  const [agentId, setAgentId] = useState("");
  const [command, setCommand] = useState("nix");
  const [args, setArgs] = useState('["run", "github:tontinton/maki", "--", "acp"]');
  const [env, setEnv] = useState("{}");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const existing = Object.entries(instances).find(([key]) => key === id)?.[1];
  function field(label: string, value: string, onChangeText: (value: string) => void) {
    return (
      <TextInput
        accessibilityLabel={label}
        placeholder={label}
        value={value}
        onChangeText={onChangeText}
        editable={!pending}
        autoCapitalize="none"
        autoCorrect={false}
        className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
      />
    );
  }
  return (
    <View className="gap-3 p-4">
      <Text className="text-lg font-semibold text-foreground">Custom ACP command</Text>
      <Text className="text-sm text-foreground-muted">
        Runs on the selected environment. Arguments are a JSON array; environment overrides are a
        JSON object. No shell is used.
      </Text>
      {Object.entries(instances)
        .filter(([, instance]) => instance.driver === "acpRegistry")
        .map(([key, instance]) => (
          <SettingsActionRow
            key={key}
            icon="pencil"
            label={`Edit ${instance.displayName ?? key}`}
            disabled={pending}
            onPress={() => {
              const config = decodeSettings(instance.config ?? {});
              setId(key);
              setName(instance.displayName ?? key);
              setCommand(config.commandPath);
              setSource(config.source);
              setAgentId(config.agentId);
              setArgs(JSON.stringify(config.commandArgs));
              setEnv(environmentEditorSeed(instance.environment));
              setMessage(null);
            }}
          />
        ))}
      {field("Instance ID", id, setId)}
      {field("Display name", name, setName)}
      <SettingsActionRow
        icon="arrow.left.arrow.right"
        label={`ACP source: ${source}. Tap to switch.`}
        disabled={pending}
        onPress={() => setSource(source === "local" ? "registry" : "local")}
      />
      {source === "registry" ? field("Registry agent ID", agentId, setAgentId) : null}
      {field("Executable", command, setCommand)}
      {field("Arguments JSON", args, setArgs)}
      {field("Environment JSON", env, setEnv)}
      <SettingsActionRow
        icon="plus"
        label={existing ? "Save ACP configuration" : "Add ACP command"}
        disabled={pending || (source === "local" ? !command.trim() : !agentId.trim())}
        onPress={() => {
          void (async () => {
            if (existing && existing.driver !== "acpRegistry") {
              // Same message the generic catch below produced for this branch.
              setMessage("Check the instance ID, arguments array, and environment object.");
              return;
            }
            setMessage(null);
            try {
              const mutation = buildProviderInstanceMutation({
                existing,
                fields: { id, name, source, agentId, command, args, env },
              });
              // Pending starts only once the payload decoded, as before.
              setPending(true);
              const result = await save({
                environmentId: environment.environmentId,
                input: { patch: {}, providerInstanceMutation: mutation },
              });
              setMessage(saveResultMessage(result));
            } catch {
              setMessage("Check the instance ID, arguments array, and environment object.");
            }
            setPending(false);
          })();
        }}
      />
      {message ? (
        <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
          {message}
        </Text>
      ) : null}
    </View>
  );
}
