import { GerritInstallationId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { isGerritBeta } from "../buildProfile.ts";
import { validateBetaHome } from "./betaHome.ts";
import { resolveBaseDir } from "../os-jank.ts";
import * as GerritTerminalGit from "../sourceControl/GerritTerminalGit.ts";
import { baseDirFlag } from "./config.ts";

const terminalGitCommand = Command.make("copy-terminal-credential", {
  baseDir: baseDirFlag,
  installation: Flag.String("installation").pipe(Flag.withSchema(GerritInstallationId)),
  environmentId: Flag.String("environment-id").pipe(
    Flag.withSchema(Schema.String.check(Schema.isNonEmpty())),
  ),
  remote: Flag.String("remote").pipe(
    Flag.withSchema(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/))),
    Flag.withDefault("origin"),
  ),
}).pipe(
  Command.withDescription(
    "On the Linux T3 server, copy this checkout's saved Gerrit HTTPS credential to its configured system libsecret helper. Requires path matching and an explicit repository username. Does not change Git config or remotes. Re-run after password rotation.",
  ),
  Command.withHandler(
    Effect.fn("cli.gerrit.setupTerminalGit")(function* (flags) {
      const environment = yield* HostProcess.Environment;
      const baseDir = yield* isGerritBeta
        ? validateBetaHome(Option.getOrUndefined(flags.baseDir))
        : resolveBaseDir(Option.getOrUndefined(flags.baseDir) ?? environment.T3CODE_HOME);
      const cwd = yield* HostProcess.WorkingDirectory;
      yield* GerritTerminalGit.GerritTerminalGit.pipe(
        Effect.flatMap((service) =>
          service.setup({
            installation: flags.installation,
            environmentId: flags.environmentId,
            remote: flags.remote,
            baseDir,
            cwd,
          }),
        ),
        Effect.provide(GerritTerminalGit.layer),
      );
      yield* Console.log(
        "Saved to the secure helper for this HTTPS repository and account. Git configuration and remotes were not changed. Re-run after password rotation. Removing the T3 connection does not remove this keyring entry.",
      );
    }),
  ),
);

export const gerritCommand = Command.make("gerrit").pipe(
  Command.withDescription("Local, user-invoked Gerrit terminal setup. No credential export API."),
  Command.withSubcommands([terminalGitCommand]),
);
