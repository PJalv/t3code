import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { TextInput, View } from "react-native";
import { AppText as Text } from "../../../components/ui/AppText";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import type { SettingsTarget } from "../settings-environment-filter";
import { ListActionRow as SettingsActionRow } from "../../../components/ui/ListActionRow";

const decodeSettings = Schema.decodeUnknownSync(AcpRegistrySettings);
const decodeEnvironment = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String));

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
              setEnv(
                JSON.stringify(
                  Object.fromEntries(
                    (instance.environment ?? [])
                      .filter((entry) => !entry.valueRedacted)
                      .map((entry) => [entry.name, entry.value]),
                  ),
                ),
              );
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
            try {
              if (existing && existing.driver !== "acpRegistry")
                throw new Error("That ID belongs to another provider.");
              const instanceId = ProviderInstanceId.make(id);
              const config = decodeSettings({
                ...(existing?.config && typeof existing.config === "object" ? existing.config : {}),
                source,
                agentId,
                commandPath: command,
                commandArgs: JSON.parse(args),
              });
              const overrides = decodeEnvironment(JSON.parse(env));
              const variables = new Map(
                (existing?.environment ?? []).map((entry) => [entry.name, entry]),
              );
              for (const [name, value] of Object.entries(overrides)) {
                variables.set(name, {
                  name,
                  value,
                  sensitive: variables.get(name)?.sensitive ?? false,
                });
              }
              const environmentVariables = [...variables.values()].filter(
                (entry) => entry.valueRedacted || Object.hasOwn(overrides, entry.name),
              );
              setPending(true);
              setMessage(null);
              const result = await save({
                environmentId: environment.environmentId,
                input: {
                  patch: {},
                  providerInstanceMutation: {
                    operation: existing ? "upsert" : "create",
                    instanceId,
                    instance: {
                      ...existing,
                      driver: ProviderDriverKind.make("acpRegistry"),
                      displayName: name.trim(),
                      config,
                      environment: environmentVariables,
                    },
                  },
                },
              });
              setMessage(result._tag === "Success" ? "Saved." : "Could not save custom command.");
            } catch {
              setMessage("Check the instance ID, arguments array, and environment object.");
            } finally {
              setPending(false);
            }
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
