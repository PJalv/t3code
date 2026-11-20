import { GerritInstallationId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export class GerritTerminalGitError extends Schema.TaggedError<GerritTerminalGitError>()(
  "GerritTerminalGitError",
  {
    reason: Schema.Literals([
      "platform",
      "environment",
      "connection",
      "remote",
      "config",
      "helper",
      "helper-config",
      "helper-chain",
      "path-matching",
      "username",
      "credential-rules",
      "credential",
      "store",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "platform":
        return "Copying saved credentials to terminal Git currently supports Linux with git-credential-libsecret only.";
      case "environment":
        return "Run on the T3 server machine as its OS user, with the correct --base-dir and environment ID. Unset GIT_* environment overrides first.";
      case "connection":
        return "Could not read the saved HTTPS Gerrit connection from this T3 home. Save HTTP credentials in Settings first.";
      case "remote":
        return "Run inside a checkout with one matching canonical HTTPS fetch and push URL. Trailing or repeated path slashes, SSH, URL rewrites, encoded paths, and ambiguous remotes are not supported. Inspect with git remote get-url --all origin and git remote get-url --push --all origin. No remote was changed.";
      case "config":
        return "Could not read a stable Git configuration. Inspect it locally with git config --show-origin --get-regexp '^credential\\.' and retry. Do not share the output if custom helper commands contain secrets. No configuration was changed.";
      case "helper-config":
        return "Configure one absolute system-installed git-credential-libsecret executable, without arguments or shell syntax. Find its path through your package manager; do not use store, cache, or manager. Inspect existing helper rules locally with git config --show-origin --get-regexp '^credential\\..*helper$'. No configuration was changed.";
      case "helper-chain":
        return "Multiple credential helpers are configured. Git can send saved passwords to every helper, including plaintext store. Review git config --show-origin --get-regexp '^credential\\..*helper$' locally and resolve the chain manually; do not blindly append or clear helpers. No configuration was changed.";
      case "path-matching":
        return "Global credential.useHttpPath=true is required, with no matching false override. Inspect git config --global --get credential.useHttpPath and git config --show-origin --get-regexp '^credential\\..*use[Hh]ttp[Pp]ath$'. Review the effect on other repositories before changing global settings. No configuration was changed.";
      case "username":
        return "Set credential.<exact-HTTPS-repository-URL>.username to the saved Gerrit HTTP username. A global username is not accepted. Use the exact URL from git remote get-url origin, including the proxy path. No configuration was changed.";
      case "credential-rules":
        return "Other URL-scoped or unsupported credential rules make this configuration ambiguous. Review git config --show-origin --get-regexp '^credential\\.' locally. Do not delete unrelated host/account rules just to pass this check. No configuration was changed.";
      case "helper":
        return "Install git-credential-libsecret and configure its absolute executable path. It and its parent directories must be system-owned, not writable by other users. Shell helpers, store, cache, and Git Credential Manager are not supported.";
      case "credential":
        return "The saved HTTP credential is invalid or does not match the username configured for this repository. No credential was transferred.";
      case "store":
        return "The secure helper could not save the credential. Check that your Linux Secret Service and unlocked keyring are available, then retry. Helper output is suppressed to protect the password.";
    }
  }
}

const safePath = /^[A-Za-z0-9._~/-]+$/;
const isInstallation = Schema.is(GerritInstallationId);
export function terminalGitTarget(installation: string, remote: string) {
  const base = URL.parse(installation);
  const url = URL.parse(remote);
  if (
    !isInstallation(installation) ||
    base?.protocol !== "https:" ||
    url === null ||
    url.protocol !== "https:" ||
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    remote.includes("?") ||
    remote.includes("#") ||
    url.href !== remote ||
    !url.pathname.startsWith(base.pathname) ||
    url.pathname === base.pathname ||
    !safePath.test(url.pathname) ||
    url.pathname.endsWith("/") ||
    url.pathname.includes("//") ||
    url.hostname.includes(":")
  ) {
    throw new GerritTerminalGitError({ reason: "remote" });
  }
  return { url: url.href, host: url.host, path: url.pathname.slice(1) };
}

export function terminalGitConfig(raw: string, target: ReturnType<typeof terminalGitTarget>) {
  const entries = raw.split("\0");
  if (entries.pop() !== "") throw new GerritTerminalGitError({ reason: "config" });
  let helper: string | undefined;
  let username: string | undefined;
  let useHttpPath: string | undefined;
  let globalUseHttpPath: string | undefined;
  const prefix = `credential.${target.url}.`;
  for (const entry of entries) {
    const separator = entry.indexOf("\n");
    const key = separator === -1 ? entry : entry.slice(0, separator);
    const value = separator === -1 ? "" : entry.slice(separator + 1);
    if (key.startsWith("url.")) throw new GerritTerminalGitError({ reason: "remote" });
    if (!key.startsWith("credential.")) continue;
    // Git accumulates matching helpers, unlike config --get-urlmatch. Accept no ambiguous rules.
    const name = key.startsWith(prefix)
      ? key.slice(prefix.length)
      : key.slice("credential.".length);
    if (name === "helper") {
      if (value === "") {
        helper = undefined;
        continue;
      }
      if (helper !== undefined) throw new GerritTerminalGitError({ reason: "helper-chain" });
      if (!/^\/[A-Za-z0-9._/-]+\/git-credential-libsecret$/.test(value)) {
        throw new GerritTerminalGitError({ reason: "helper-config" });
      }
      helper = value;
    } else if (name === "usehttppath") {
      useHttpPath = value;
      if (key === "credential.usehttppath") globalUseHttpPath = value;
    } else if (name === "username" && key.startsWith(prefix)) {
      username = value;
    } else {
      throw new GerritTerminalGitError({
        reason: key === "credential.username" ? "username" : "credential-rules",
      });
    }
  }
  if (!helper) throw new GerritTerminalGitError({ reason: "helper-config" });
  if (globalUseHttpPath !== "true" || useHttpPath !== "true") {
    throw new GerritTerminalGitError({ reason: "path-matching" });
  }
  if (!username || /[\x00-\x1f\x7f]/.test(username)) {
    throw new GerritTerminalGitError({ reason: "username" });
  }
  return { helper, username };
}
