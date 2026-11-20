import { T, useGT } from "gt-react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  gerritConnectionConfigFromFields,
  gerritCredentialSaveMode,
  gerritTerminalGitCommandTemplate,
} from "@t3tools/client-runtime/state/source-control";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { useId, useState } from "react";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SettingsRow } from "./settingsLayout";
import { SecretInput } from "./SecretInput";
import { GerritHookSetup } from "./GerritHookSetup";
import { namedClipboardTarget, useCopyToClipboard } from "../../hooks/useCopyToClipboard";

export function GerritConnectionSettings({
  environmentId,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly onSaved: () => void;
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
        <T>
          Connections and credentials belong to this environment. Each server covers all of its
          Gerrit projects.
        </T>
      </p>
      {connections.error ? <p role="alert">{connections.error}</p> : null}
      {installation.trim().toLowerCase().startsWith("http://") ? (
        <p role="status" className="px-4 text-xs text-warning">
          <T>
            HTTP does not encrypt credentials or protect the server’s commit hook. Use HTTPS when
            available.
          </T>
        </p>
      ) : null}
      <div className="grid gap-2 px-4">
        <label htmlFor={hookPathId} className="text-sm font-medium">
          <T>Change-Id hook checkout</T>
        </label>
        <div className="flex gap-2">
          <Input
            id={hookPathId}
            value={hookPath}
            onChange={(event) => setHookPath(event.target.value)}
            placeholder={gt("Absolute checkout path")}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!hookPath.trim()}
            onClick={() => setHookCheckout(hookPath.trim())}
          >
            <T>Check hook</T>
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
            {connection.credentialPresent ? gt("Credentials saved") : gt("Credentials missing")}
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
                  gt("Leave both HTTP credential fields blank to keep the saved credentials."),
                );
              }}
            >
              <T>Edit</T>
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
                    ? result.value.version.kind === "observed"
                      ? gt("Verified account {account} · Gerrit {version}", {
                          account: result.value.account._account_id,
                          version: result.value.version.value,
                        })
                      : gt("Verified account {account} · Gerrit version unknown", {
                          account: result.value.account._account_id,
                        })
                    : gt("Connection test failed. Check the server URL and credentials."),
                );
                setBusy(false);
              }}
            >
              <T>Test connection</T>
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
                    ? gt("Credentials removed.")
                    : gt("Could not remove credentials."),
                );
                setBusy(false);
                refresh();
              }}
            >
              <T>Remove credentials</T>
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
                    ? gt("Connection removed.")
                    : gt("Could not remove connection."),
                );
                setBusy(false);
                refresh();
              }}
            >
              <T>Remove connection</T>
            </Button>
          </div>
          {connection.credentialPresent &&
          gerritTerminalGitCommandTemplate(connection.config.installation, environmentId) ? (
            <div className="grid gap-2">
              <p className="text-sm font-medium">
                <T>Copy saved credential to configured Git</T>
              </p>
              <p className="text-xs text-muted-foreground">
                <T>
                  Copy an editable command template, not a ready-to-run command. Replace the
                  launcher and T3 home placeholders using the server’s launch configuration. For a
                  packaged install, use its absolute CLI path; do not assume this client’s t3
                  command is correct. For a dev server, use node and that checkout’s
                  apps/server/src/bin.ts; its home is normally the checkout’s .t3 directory unless
                  --home-dir overrides it.
                </T>
              </p>
              <p className="text-xs text-muted-foreground">
                <T>
                  Run inside the HTTPS checkout on this environment’s T3 server machine as its OS
                  user, not on a remote client. Linux libsecret only, already configured with global
                  credential.useHttpPath=true and an exact repository username. The command copies
                  the saved credential without changing Git config or remotes. Re-run after password
                  rotation. Removing this connection does not remove the keyring entry.
                </T>
              </p>
              <GerritCommandTemplateCopy
                key={environmentId}
                command={gerritTerminalGitCommandTemplate(
                  connection.config.installation,
                  environmentId,
                )!}
              />
            </div>
          ) : null}
        </div>
      ))}
      {checksProfile === "checks-rest-v1-3.10" ? (
        <div className="grid gap-2">
          <p className="text-xs">
            <T>This server has a legacy checks integration enabled.</T>
          </p>
          <Button disabled={!canWrite || busy} onClick={() => setChecksProfile("none")}>
            <T>Remove legacy checks integration</T>
          </Button>
          <p className="text-xs">
            <T>Save the server settings to apply this change.</T>
          </p>
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
              ? gt("Saved. Test the connection to verify the current account.")
              : gt("Could not save the connection."),
          );
          if (result._tag === "Success") refresh();
        }}
      >
        <fieldset disabled={!canWrite || busy} className="grid gap-2">
          <SettingsRow
            title={
              <label htmlFor="gerrit-server-url">
                <T>Gerrit server URL</T>
              </label>
            }
            description={gt("Full REST URL, including its case-sensitive path.")}
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
            title={
              <label htmlFor="gerrit-ssh-host">
                <T>SSH clone host</T>
              </label>
            }
            description={gt(
              "Optional. Connect an SSH checkout to this server for local operations.",
            )}
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
            title={
              <label htmlFor="gerrit-ssh-port">
                <T>SSH port</T>
              </label>
            }
            description={gt("Optional. Defaults to 29418.")}
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
            title={
              <label htmlFor="gerrit-ssh-username">
                <T>SSH username</T>
              </label>
            }
            description={gt("Optional username for the SSH clone host.")}
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
            title={
              <label htmlFor="gerrit-http-username">
                <T>HTTP username</T>
              </label>
            }
            description={gt("Leave both credential fields blank to keep saved credentials.")}
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
            title={
              <label htmlFor="gerrit-http-token">
                <T>HTTP password or token</T>
              </label>
            }
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
              <T>Save connection</T>
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

function GerritCommandTemplateCopy({ command }: { readonly command: string }) {
  const gt = useGT();
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "error">("idle");
  const { copyToClipboard } = useCopyToClipboard({
    target: namedClipboardTarget(gt("terminal Git command template")),
    onCopy: () => setStatus("copied"),
    onError: () => setStatus("error"),
  });
  return (
    <div className="grid justify-items-start gap-2">
      <Button
        size="xs"
        variant="outline"
        disabled={status === "copying"}
        onClick={() => {
          setStatus("copying");
          copyToClipboard(command, undefined);
        }}
      >
        <T>Copy command template</T>
      </Button>
      {status === "copying" || status === "copied" ? (
        <p role="status" className="text-xs text-muted-foreground">
          {status === "copying" ? gt("Copying command template…") : gt("Command template copied.")}
        </p>
      ) : null}
      {status === "error" ? (
        <>
          <p role="alert" className="text-xs text-destructive">
            <T>Could not copy the command template. Select and copy it below, or try again.</T>
          </p>
          <Textarea
            aria-label={gt("Command template")}
            readOnly
            value={command}
            onFocus={(event) => event.currentTarget.select()}
          />
        </>
      ) : null}
    </div>
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
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (passphrase.length > 0 && !/[\r\n]/.test(passphrase)) void save(passphrase);
      }}
    >
      <fieldset disabled={!canWrite || busy} className="grid gap-2">
        <SettingsRow
          title={
            <label htmlFor="gerrit-gpg-passphrase">
              <T>GPG key passphrase</T>
            </label>
          }
          description={
            present
              ? gt(
                  "Saved on this environment's server. Used to sign commits when Git has commit.gpgSign enabled. Leave blank to keep it.",
                )
              : gt(
                  "Required to sign commits when Git has commit.gpgSign enabled. Stored on this environment's server.",
                )
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
            <T>Clear passphrase</T>
          </Button>
          <Button size="sm" type="submit" disabled={passphrase.length === 0}>
            <T>Save passphrase</T>
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
