import { T, useGT } from "gt-react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  gerritConnectionConfigFromFields,
  gerritCredentialSaveMode,
} from "@t3tools/client-runtime/state/source-control";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { useState } from "react";
import { TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

export function GerritConnectionSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const connections = useEnvironmentQuery(
    sourceControlEnvironment.gerritConnections({ environmentId, input: {} }),
  );
  const canWrite = useAtomValue(
    sourceControlEnvironment.gerritConfigure.permissionAtom(environmentId),
  );
  const configure = useAtomCommand(sourceControlEnvironment.gerritConfigure);
  const test = useAtomCommand(sourceControlEnvironment.gerritTest);
  const remove = useAtomCommand(sourceControlEnvironment.gerritRemove);
  const removeCredentials = useAtomCommand(sourceControlEnvironment.gerritRemoveCredentials);
  const [installation, setInstallation] = useState("");
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState("");
  const [sshUsername, setSshUsername] = useState("");
  const [checksProfile, setChecksProfile] = useState<"none" | "checks-rest-v1-3.10" | undefined>();
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  // A result shows beside the connection it is about; null is the form's own save result.
  const [notice, setNotice] = useState<{
    readonly installation: string | null;
    readonly text: string;
  } | null>(null);
  const savedConnections =
    connections.isSuccess && !connections.isPending ? (connections.data ?? []) : [];
  const config = gerritConnectionConfigFromFields(
    {
      installation,
      sshHost,
      sshPort,
      sshUsername,
      ...(checksProfile === undefined ? {} : { checksProfile }),
    },
    savedConnections,
  );
  const credentialMode = gerritCredentialSaveMode({
    installation: Option.isSome(config) ? config.value.installation : null,
    connections: savedConnections,
    username,
    token,
  });
  const canKeepCredentials = credentialMode === "keep";
  const canSaveCredentials = credentialMode !== "invalid";
  const field = (
    label: string,
    value: string,
    onChangeText: (value: string) => void,
    secret = false,
  ) => (
    <View className="gap-1">
      <Text className="text-sm text-foreground-muted">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
        placeholderTextColorClassName="accent-foreground-muted"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        secureTextEntry={secret}
        editable={canWrite && !busy}
        value={value}
        onChangeText={onChangeText}
      />
    </View>
  );
  return (
    <View className="gap-3 px-4 py-3">
      <Text className="text-sm text-foreground-muted">
        <T>
          Credentials and Gerrit servers belong to this environment. A configured server serves all
          its Gerrit projects. Enter the full server URL for REST access, including its
          case-sensitive path.
        </T>
      </Text>
      {connections.error ? <Text accessibilityRole="alert">{connections.error}</Text> : null}
      {installation.trim().toLowerCase().startsWith("http://") ? (
        <Text accessibilityRole="alert">
          <T>
            HTTP does not encrypt credentials or protect the server’s commit hook. Use HTTPS when
            available.
          </T>
        </Text>
      ) : null}
      {savedConnections.map((connection) => (
        <View key={connection.config.installation} className="gap-2">
          <Text>
            {connection.config.installation} ·{" "}
            {connection.credentialPresent ? gt("Credentials saved") : gt("Credentials missing")}
          </Text>
          <Button
            label={gt("Edit connection")}
            disabled={!canWrite || busy}
            onPress={() => {
              setInstallation(connection.config.installation);
              setSshHost(connection.config.sshHost?.host ?? "");
              setSshPort(connection.config.sshHost?.port?.toString() ?? "");
              setSshUsername(connection.config.sshHost?.username ?? "");
              setChecksProfile(connection.config.checksProfile ?? "none");
              setUsername("");
              setToken("");
              setNotice(null);
            }}
          />
          <Button
            label={gt("Test connection")}
            disabled={!canWrite || busy}
            onPress={async () => {
              setBusy(true);
              const result = await test({
                environmentId,
                input: { installation: connection.config.installation },
              });
              setNotice({
                installation: connection.config.installation,
                text:
                  result._tag === "Success"
                    ? gt("Verified account {account}. Deployment compatibility is unverified.", {
                        account: result.value.account._account_id,
                      })
                    : gt("Connection test failed. Check the server URL and credentials."),
              });
              setBusy(false);
            }}
          />
          <Button
            label={gt("Remove credentials")}
            disabled={!canWrite || busy || !connection.credentialPresent}
            onPress={async () => {
              setBusy(true);
              const result = await removeCredentials({
                environmentId,
                input: { installation: connection.config.installation },
              });
              setNotice({
                installation: connection.config.installation,
                text:
                  result._tag === "Success"
                    ? gt("Credentials removed.")
                    : gt("Could not remove credentials."),
              });
              setBusy(false);
              connections.refresh();
            }}
          />
          <Button
            label={gt("Remove connection")}
            tone="danger"
            disabled={!canWrite || busy}
            onPress={async () => {
              setBusy(true);
              const result = await remove({
                environmentId,
                input: { installation: connection.config.installation },
              });
              setNotice(
                result._tag === "Success"
                  ? { installation: null, text: gt("Connection removed.") }
                  : {
                      installation: connection.config.installation,
                      text: gt("Could not remove connection."),
                    },
              );
              setBusy(false);
              connections.refresh();
            }}
          />
          {notice?.installation === connection.config.installation ? (
            <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
              {notice.text}
            </Text>
          ) : null}
        </View>
      ))}
      {checksProfile === "checks-rest-v1-3.10" ? (
        <View>
          <Text>
            <T>This server has a legacy checks integration enabled.</T>
          </Text>
          <Button
            label={gt("Remove legacy checks integration")}
            disabled={!canWrite || busy}
            onPress={() => setChecksProfile("none")}
          />
          <Text>
            <T>Save the server settings to apply this change.</T>
          </Text>
        </View>
      ) : null}
      {field(gt("Gerrit server URL"), installation, setInstallation)}
      {field(gt("SSH clone host (optional)"), sshHost, setSshHost)}
      {field(gt("SSH port (optional; default 29418)"), sshPort, setSshPort)}
      {field(gt("SSH username (optional)"), sshUsername, setSshUsername)}
      <Text>
        <T>Leave both HTTP credential fields blank to keep saved credentials for this server.</T>
      </Text>
      {field(gt("HTTP username"), username, setUsername)}
      {field(gt("HTTP password or token"), token, setToken, true)}
      <Button
        label={gt("Save connection")}
        disabled={
          !canWrite ||
          busy ||
          Option.isNone(config) ||
          !connections.isSuccess ||
          connections.isPending ||
          !canSaveCredentials
        }
        onPress={async () => {
          if (
            Option.isNone(config) ||
            busy ||
            !canWrite ||
            !connections.isSuccess ||
            connections.isPending ||
            !canSaveCredentials
          )
            return;
          setBusy(true);
          const result = await configure({
            environmentId,
            input: {
              config: config.value,
              ...(canKeepCredentials ? {} : { credentials: { username, token } }),
            },
          });
          setToken("");
          setBusy(false);
          setNotice({
            installation: null,
            text:
              result._tag === "Success"
                ? gt("Saved. Test the connection to verify the account.")
                : gt("Could not save connection."),
          });
          connections.refresh();
        }}
      />
      {notice?.installation === null ? (
        <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
          {notice.text}
        </Text>
      ) : null}
      <GerritSigningPassphraseSettings environmentId={environmentId} />
    </View>
  );
}

function GerritSigningPassphraseSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const status = useEnvironmentQuery(
    sourceControlEnvironment.gerritSigningPassphrase({ environmentId, input: {} }),
  );
  const canWrite = useAtomValue(
    sourceControlEnvironment.gerritSetSigningPassphrase.permissionAtom(environmentId),
  );
  const setPassphrase = useAtomCommand(sourceControlEnvironment.gerritSetSigningPassphrase);
  const [passphrase, setPassphraseValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const present = status.isSuccess && status.data?.present === true;
  const save = async (value: string | null) => {
    setBusy(true);
    const result = await setPassphrase({ environmentId, input: { passphrase: value } });
    setPassphraseValue("");
    setBusy(false);
    setMessage(
      result._tag === "Success"
        ? value === null
          ? gt("GPG key passphrase cleared.")
          : gt("GPG key passphrase saved.")
        : gt("Could not update the GPG key passphrase."),
    );
    status.refresh();
  };
  return (
    <View className="gap-2">
      <Text className="text-sm text-foreground-muted">
        <T>GPG key passphrase</T>
      </Text>
      <Text>
        {present
          ? gt(
              "Saved on this environment's server. Used to sign commits when Git has commit.gpgSign enabled. Leave blank to keep it.",
            )
          : gt(
              "Required to sign commits when Git has commit.gpgSign enabled. Stored on this environment's server.",
            )}
      </Text>
      <TextInput
        accessibilityLabel={gt("GPG key passphrase")}
        className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
        placeholderTextColorClassName="accent-foreground-muted"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        secureTextEntry
        editable={canWrite && !busy}
        value={passphrase}
        onChangeText={setPassphraseValue}
      />
      <Button
        label={gt("Save passphrase")}
        disabled={!canWrite || busy || passphrase.length === 0 || /[\r\n]/.test(passphrase)}
        onPress={() => void save(passphrase)}
      />
      <Button
        label={gt("Clear passphrase")}
        disabled={!canWrite || busy || !present}
        onPress={() => void save(null)}
      />
      {message ? (
        <Text accessibilityRole="text" className="text-sm text-foreground-muted">
          {message}
        </Text>
      ) : null}
    </View>
  );
}
