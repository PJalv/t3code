import type { EnvironmentId } from "@t3tools/contracts";
import {
  gerritConnectionConfigFromFields,
  gerritCredentialSaveMode,
} from "@t3tools/client-runtime/state/source-control";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { useId, useState } from "react";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";
import { SecretInput } from "./SecretInput";
import { GerritHookSetup } from "./GerritHookSetup";

export function GerritConnectionSettings({
  environmentId,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly onSaved: () => void;
}) {
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
  const [hookPath, setHookPath] = useState("");
  const [hookCheckout, setHookCheckout] = useState("");
  const hookPathId = useId();
  const [installation, setInstallation] = useState("");
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState("");
  const [sshUsername, setSshUsername] = useState("");
  const [checksProfile, setChecksProfile] = useState<"none" | "checks-rest-v1-3.10" | undefined>();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
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
    token: password,
  });
  const canKeepCredentials = credentialMode === "keep";
  const canSaveCredentials = credentialMode !== "invalid";
  const refresh = () => {
    connections.refresh();
    onSaved();
  };
  return (
    <div className="grid gap-4">
      <p className="px-4 text-xs text-muted-foreground">
        Connections and credentials belong to this environment. Each server covers all of its Gerrit
        projects.
      </p>
      {connections.error ? <p role="alert">{connections.error}</p> : null}
      {installation.trim().toLowerCase().startsWith("http://") ? (
        <p role="status" className="px-4 text-xs text-warning">
          HTTP does not encrypt credentials or protect the server’s commit hook. Use HTTPS when
          available.
        </p>
      ) : null}
      <div className="grid gap-2 px-4">
        <label htmlFor={hookPathId} className="text-sm font-medium">
          Change-Id hook checkout
        </label>
        <div className="flex gap-2">
          <Input
            id={hookPathId}
            value={hookPath}
            onChange={(event) => setHookPath(event.target.value)}
            placeholder="Absolute checkout path"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!hookPath.trim()}
            onClick={() => setHookCheckout(hookPath.trim())}
          >
            Check hook
          </Button>
        </div>
        {hookCheckout ? (
          <GerritHookSetup key={hookCheckout} environmentId={environmentId} cwd={hookCheckout} />
        ) : null}
      </div>
      {savedConnections.map((connection) => (
        <div key={connection.config.installation} className="grid gap-2 px-4 py-2">
          <p className="break-all text-sm">
            {connection.config.installation} ·{" "}
            {connection.credentialPresent ? "Credentials saved" : "Credentials missing"}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={!canWrite || busy}
              onClick={() => {
                setInstallation(connection.config.installation);
                setSshHost(connection.config.sshHost?.host ?? "");
                setSshPort(connection.config.sshHost?.port?.toString() ?? "");
                setSshUsername(connection.config.sshHost?.username ?? "");
                setChecksProfile(connection.config.checksProfile ?? "none");
                setUsername("");
                setPassword("");
                setMessage(
                  "Leave both HTTP credential fields blank to keep the saved credentials.",
                );
              }}
            >
              Edit
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={!canWrite || busy}
              onClick={async () => {
                setBusy(true);
                const result = await test({
                  environmentId,
                  input: { installation: connection.config.installation },
                });
                setMessage(
                  result._tag === "Success"
                    ? `Verified account ${result.value.account._account_id} · Gerrit ${result.value.version.kind === "observed" ? result.value.version.value : "version unknown"}`
                    : "Connection test failed. Check the server URL and credentials.",
                );
                setBusy(false);
              }}
            >
              Test connection
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={!canWrite || busy || !connection.credentialPresent}
              onClick={async () => {
                setBusy(true);
                const result = await removeCredentials({
                  environmentId,
                  input: { installation: connection.config.installation },
                });
                setMessage(
                  result._tag === "Success"
                    ? "Credentials removed."
                    : "Could not remove credentials.",
                );
                setBusy(false);
                refresh();
              }}
            >
              Remove credentials
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={!canWrite || busy}
              onClick={async () => {
                setBusy(true);
                const result = await remove({
                  environmentId,
                  input: { installation: connection.config.installation },
                });
                setMessage(
                  result._tag === "Success"
                    ? "Connection removed."
                    : "Could not remove connection.",
                );
                setBusy(false);
                refresh();
              }}
            >
              Remove connection
            </Button>
          </div>
        </div>
      ))}
      {checksProfile === "checks-rest-v1-3.10" ? (
        <div className="grid gap-2">
          <p className="text-xs">This server has a legacy checks integration enabled.</p>
          <Button disabled={!canWrite || busy} onClick={() => setChecksProfile("none")}>
            Remove legacy checks integration
          </Button>
          <p className="text-xs">Save the server settings to apply this change.</p>
        </div>
      ) : null}
      <form
        className="grid gap-3"
        onSubmit={async (event) => {
          event.preventDefault();
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
              ...(canKeepCredentials ? {} : { credentials: { username, token: password } }),
            },
          });
          setPassword("");
          setBusy(false);
          setMessage(
            result._tag === "Success"
              ? "Saved. Test the connection to verify the current account."
              : "Could not save the connection.",
          );
          if (result._tag === "Success") refresh();
        }}
      >
        <fieldset disabled={!canWrite || busy} className="grid gap-2">
          <SettingsRow
            title={<label htmlFor="gerrit-server-url">Gerrit server URL</label>}
            description="Full REST URL, including its case-sensitive path."
            control={
              <div className="w-56 max-w-full">
                <Input
                  id="gerrit-server-url"
                  value={installation}
                  onChange={(event) => setInstallation(event.target.value)}
                  autoComplete="off"
                />
              </div>
            }
          />
          <SettingsRow
            title={<label htmlFor="gerrit-ssh-host">SSH clone host</label>}
            description="Optional. Connect an SSH checkout to this server for local operations."
            control={
              <div className="w-56 max-w-full">
                <Input
                  id="gerrit-ssh-host"
                  value={sshHost}
                  onChange={(event) => setSshHost(event.target.value)}
                  placeholder="gerrit-ssh.example.com"
                  autoComplete="off"
                />
              </div>
            }
          />
          <SettingsRow
            title={<label htmlFor="gerrit-ssh-port">SSH port</label>}
            description="Optional. Defaults to 29418."
            control={
              <div className="w-56 max-w-full">
                <Input
                  id="gerrit-ssh-port"
                  value={sshPort}
                  onChange={(event) => setSshPort(event.target.value)}
                  inputMode="numeric"
                  autoComplete="off"
                />
              </div>
            }
          />
          <SettingsRow
            title={<label htmlFor="gerrit-ssh-username">SSH username</label>}
            description="Optional username for the SSH clone host."
            control={
              <div className="w-56 max-w-full">
                <Input
                  id="gerrit-ssh-username"
                  value={sshUsername}
                  onChange={(event) => setSshUsername(event.target.value)}
                  autoComplete="off"
                />
              </div>
            }
          />
          <SettingsRow
            title={<label htmlFor="gerrit-http-username">HTTP username</label>}
            description="Leave both credential fields blank to keep saved credentials."
            control={
              <div className="w-56 max-w-full">
                <Input
                  id="gerrit-http-username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="off"
                />
              </div>
            }
          />
          <SettingsRow
            title={<label htmlFor="gerrit-http-token">HTTP password or token</label>}
            control={
              <div className="w-56 max-w-full">
                <SecretInput
                  id="gerrit-http-token"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
            }
          />
          <div className="flex justify-end px-4 pt-2">
            <Button
              size="sm"
              type="submit"
              disabled={
                Option.isNone(config) ||
                !connections.isSuccess ||
                connections.isPending ||
                !canSaveCredentials
              }
            >
              Save connection
            </Button>
          </div>
        </fieldset>
      </form>
      {message ? (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
      <GerritSigningPassphraseSettings environmentId={environmentId} />
    </div>
  );
}

function GerritSigningPassphraseSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
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
          ? "GPG key passphrase cleared."
          : "GPG key passphrase saved."
        : "Could not update the GPG key passphrase.",
    );
    status.refresh();
  };
  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (passphrase.length > 0 && !/[\r\n]/.test(passphrase)) void save(passphrase);
      }}
    >
      <fieldset disabled={!canWrite || busy} className="grid gap-2">
        <SettingsRow
          title={<label htmlFor="gerrit-gpg-passphrase">GPG key passphrase</label>}
          description={
            present
              ? "Saved on this environment's server. Used to sign commits when Git has commit.gpgSign enabled. Leave blank to keep it."
              : "Required to sign commits when Git has commit.gpgSign enabled. Stored on this environment's server."
          }
          control={
            <div className="w-56 max-w-full">
              <SecretInput
                id="gerrit-gpg-passphrase"
                value={passphrase}
                onChange={(event) => setPassphraseValue(event.target.value)}
              />
            </div>
          }
        />
        <div className="flex justify-end gap-2 px-4 pt-2">
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={!present}
            onClick={() => void save(null)}
          >
            Clear passphrase
          </Button>
          <Button size="sm" type="submit" disabled={passphrase.length === 0}>
            Save passphrase
          </Button>
        </div>
      </fieldset>
      {message ? (
        <p role="status" className="px-4 text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
    </form>
  );
}
