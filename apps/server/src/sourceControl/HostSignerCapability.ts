// @effect-diagnostics extendsNativeError:off -- Plain async helpers reject with native errors; callers map them.
// @effect-diagnostics nodeBuiltinImport:off -- Descriptor-pinned Linux execution needs inherited file descriptors.
// @effect-diagnostics globalTimers:off -- The child process boundary enforces a deadline.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeStream from "node:stream";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { parseEffectiveSigningConfig } from "./GerritEffectiveSigningConfig.ts";
import { withHeldConfigFile } from "./HeldConfigFile.ts";
import { auditGitConfigPath } from "./GitConfigPathAudit.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

export class HostSignerError extends Error {
  readonly reason: "unsupported" | "untrusted" | "changed" | "cancelled" | "failed";
  constructor(reason: HostSignerError["reason"]) {
    super(`Host signer ${reason}`);
    this.reason = reason;
  }
}
declare const hostSignerBrand: unique symbol;
export interface HostSignerCapability {
  readonly kind: "host-signer-capability";
  readonly [hostSignerBrand]: never;
}
type State = {
  alias: string;
  capturedPath: string;
  binaryName: "gpg" | "gpgconf" | "git";
  repo: string;
  canonical: string;
  handle: NodeFSP.FileHandle;
  stat: NodeFS.Stats;
  closed: boolean;
  running: PromiseWithResolvers<void> | null;
};
const states = new WeakMap<HostSignerCapability, State>();

const modeSafe = (stat: NodeFS.Stats, path: string) =>
  stat.uid === 0 &&
  ((stat.mode & 0o022) === 0 ||
    (path === "/nix/store" &&
      stat.isDirectory() &&
      (stat.mode & 0o1000) !== 0 &&
      (stat.mode & 0o002) === 0));
const same = (a: NodeFS.Stats, b: NodeFS.Stats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.mode === b.mode &&
  a.uid === b.uid &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
async function protectedChain(path: string) {
  if (!NodePath.isAbsolute(path)) throw new HostSignerError("untrusted");
  let current = "/";
  if (!modeSafe(await NodeFSP.lstat(current), current)) throw new HostSignerError("untrusted");
  for (const part of path.split("/").filter(Boolean)) {
    current = NodePath.join(current, part);
    const info = await NodeFSP.lstat(current);
    if (!info.isSymbolicLink() && !modeSafe(info, current)) throw new HostSignerError("untrusted");
    if (info.isSymbolicLink() && info.uid !== 0) throw new HostSignerError("untrusted");
    const real = await NodeFSP.realpath(current);
    if (real !== current) {
      if (real === path || real.startsWith(`${current}/`)) throw new HostSignerError("untrusted");
      await protectedChain(real);
    }
  }
}
async function resolveAlias(alias: string, repo: string) {
  if (!NodePath.isAbsolute(alias) || !NodePath.isAbsolute(repo))
    throw new HostSignerError("untrusted");
  await protectedChain(alias);
  const canonical = await NodeFSP.realpath(alias);
  const repository = await NodeFSP.realpath(repo);
  if (canonical === repository || canonical.startsWith(`${repository}/`))
    throw new HostSignerError("untrusted");
  await protectedChain(canonical);
  return canonical;
}

async function winningAlias(capturedPath: string, binaryName: "gpg" | "gpgconf" | "git") {
  const dirs = capturedPath.split(NodePath.delimiter);
  if (dirs.some((dir) => !dir || !NodePath.isAbsolute(dir))) throw new HostSignerError("untrusted");
  let alias: string | undefined;
  for (const dir of dirs) {
    const candidate = NodePath.join(dir, binaryName);
    try {
      const info = await NodeFSP.stat(candidate);
      if (info.isFile() && (info.mode & 0o111) !== 0) {
        alias = candidate;
        break;
      }
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        (error as NodeJS.ErrnoException).code !== "ENOTDIR"
      )
        throw new HostSignerError("untrusted");
    }
  }
  if (!alias) throw new HostSignerError("untrusted");
  return alias;
}

/** The captured PATH is an environment-owned value; repository input must never supply it. */
// Push certificates use Git's native signer protocol, but never a repository-selected program.
export async function trustedPushGpg(capturedPath: string, repo: string): Promise<string> {
  if (HostProcess.Platform.defaultValue() !== "linux") throw new HostSignerError("unsupported");
  const alias = await winningAlias(capturedPath, "gpg");
  const canonical = await resolveAlias(alias, repo);
  const handle = await NodeFSP.open(
    canonical,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    const header = Buffer.alloc(4);
    const read = await handle.read(header, 0, 4, 0);
    if (
      !stat.isFile() ||
      !modeSafe(stat, canonical) ||
      !(stat.mode & 0o111) ||
      read.bytesRead !== 4 ||
      !header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      (await resolveAlias(alias, repo)) !== canonical
    )
      throw new HostSignerError("untrusted");
    return canonical;
  } finally {
    await handle.close();
  }
}

async function issueHostSignerCapability(
  capturedPath: string,
  repo: string,
  binaryName: "gpg" | "gpgconf" | "git",
): Promise<HostSignerCapability> {
  if (HostProcess.Platform.defaultValue() !== "linux") throw new HostSignerError("unsupported");
  const alias = await winningAlias(capturedPath, binaryName);
  let handle: NodeFSP.FileHandle | undefined;
  try {
    const canonical = await resolveAlias(alias, repo);
    handle = await NodeFSP.open(canonical, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
    const stat = await handle.stat();
    const header = Buffer.alloc(4);
    const read = await handle.read(header, 0, 4, 0);
    if (
      !stat.isFile() ||
      !modeSafe(stat, canonical) ||
      (stat.mode & 0o111) === 0 ||
      read.bytesRead !== 4 ||
      !header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    )
      throw new HostSignerError("untrusted");
    if (
      (await resolveAlias(alias, repo)) !== canonical ||
      !same(stat, await NodeFSP.stat(canonical))
    )
      throw new HostSignerError("changed");
    const capability = Object.freeze({
      kind: "host-signer-capability" as const,
    }) as HostSignerCapability;
    states.set(capability, {
      alias,
      capturedPath,
      binaryName,
      repo,
      canonical,
      handle,
      stat,
      closed: false,
      running: null,
    });
    return capability;
  } catch (error) {
    await handle?.close();
    if (error instanceof HostSignerError) throw error;
    throw new HostSignerError("untrusted");
  }
}
async function closeHostSignerCapability(capability: HostSignerCapability): Promise<void> {
  const state = states.get(capability);
  if (!state) throw new HostSignerError("untrusted");
  if (!state.closed) {
    state.closed = true;
    if (state.running) await state.running.promise;
    await state.handle.close();
  }
}
export type HostGpgRequest =
  | { readonly kind: "list"; readonly fingerprint: string }
  | { readonly kind: "export"; readonly fingerprint: string }
  | {
      readonly kind: "sign";
      readonly fingerprint: string;
      readonly data: Uint8Array;
      readonly passphrase: Uint8Array;
    }
  | { readonly kind: "verify"; readonly signature: Uint8Array; readonly data: Uint8Array };

declare const gitConfigBrand: unique symbol;
export interface FrozenHostGitConfig {
  readonly [gitConfigBrand]: never;
  readonly digest: string;
  readonly fingerprint: string;
  readonly program: string;
}

async function auditGitConfigGraph(
  capability: HostSignerCapability,
  environment: NodeJS.ProcessEnv,
  uid: number,
  platform: NodeJS.Platform,
  effective: Buffer | undefined,
  signal: AbortSignal,
) {
  const state = states.get(capability);
  if (
    !state ||
    state.closed ||
    !NodePath.isAbsolute(state.repo) ||
    NodePath.normalize(state.repo) !== state.repo
  )
    throw new HostSignerError("untrusted");
  const decode = (buffer: Buffer) => {
    const value = buffer.toString("utf8");
    if (!Buffer.from(value).equals(buffer)) throw new HostSignerError("untrusted");
    return value;
  };
  const lines = (buffer: Buffer) => {
    const value = decode(buffer);
    if (!value.endsWith("\n") || value.includes("\0") || value.includes("\r"))
      throw new HostSignerError("untrusted");
    return value.slice(0, -1).split("\n").filter(Boolean);
  };
  const single = async (kind: "gitdir" | "common" | "toplevel" | "head") => {
    const values = lines(await runPinnedGitConfig(capability, environment, signal, { kind }));
    if (values.length !== 1) throw new HostSignerError("untrusted");
    return values[0]!;
  };
  const rawGitdir = await single("gitdir");
  const rawCommon = await single("common");
  const rawTop = await single("toplevel");
  const head = await single("head");
  const cleanPath = (path: string, base: string) => {
    if (!path || /[\0\r\n]/.test(path) || path.split("/").includes(".."))
      throw new HostSignerError("untrusted");
    const value = NodePath.isAbsolute(path) ? path : NodePath.join(base, path);
    if (
      !NodePath.isAbsolute(value) ||
      value !== NodePath.normalize(value) ||
      Buffer.byteLength(value) > 4096
    )
      throw new HostSignerError("untrusted");
    return value;
  };
  const resolveInclude = async (value: string, base: string) => {
    if (!value || /[\0\r\n]/.test(value)) throw new HostSignerError("untrusted");
    let current = NodePath.isAbsolute(value) ? "/" : base;
    for (const part of value.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if ((await auditGitConfigPath(current, uid, platform, true)).missing)
          throw new HostSignerError("untrusted");
        current = NodePath.dirname(current);
      } else current = NodePath.join(current, part);
    }
    return cleanPath(current, base);
  };
  const gitdir = cleanPath(rawGitdir, state.repo),
    common = cleanPath(rawCommon, state.repo),
    top = cleanPath(rawTop, state.repo);
  const system = lines(
    await runPinnedGitConfig(capability, environment, signal, { kind: "system" }),
  );
  const global = lines(
    await runPinnedGitConfig(capability, environment, signal, { kind: "global" }),
  );
  const candidates = [...system, ...global].map((path) => cleanPath(path, state.repo));
  candidates.push(NodePath.join(common, "config"), NodePath.join(gitdir, "config.worktree"));
  const entries = new Map<string, string>();
  const contextPaths = [NodePath.join(gitdir, "HEAD"), NodePath.join(gitdir, "commondir")];
  const dotgit = NodePath.join(top, ".git");
  const dotgitInfo = await NodeFSP.lstat(dotgit);
  if (dotgitInfo.isSymbolicLink()) throw new HostSignerError("untrusted");
  if (dotgitInfo.isFile()) contextPaths.push(dotgit);
  else if (!dotgitInfo.isDirectory()) throw new HostSignerError("untrusted");
  for (const path of contextPaths) {
    const status = await auditGitConfigPath(path, uid, platform);
    if (status.missing) {
      if (path.endsWith("/HEAD")) throw new HostSignerError("untrusted");
      entries.set(path, "absent");
      continue;
    }
    const fingerprint = await withHeldConfigFile(path, async (data, stat) =>
      NodeCrypto.createHash("sha256")
        .update(
          JSON.stringify([
            stat.dev,
            stat.ino,
            stat.mode,
            stat.uid,
            stat.gid,
            stat.size,
            stat.mtimeMs,
            stat.ctimeMs,
          ]),
        )
        .update(data)
        .digest("hex"),
    );
    entries.set(path, fingerprint);
  }
  const visited = new Set<string>();
  const visit = async (path: string, depth: number): Promise<void> => {
    if (signal.aborted) throw new HostSignerError("cancelled");
    if (depth > 16 || visited.size >= 128) throw new HostSignerError("untrusted");
    if (visited.has(path)) return;
    visited.add(path);
    const status = await auditGitConfigPath(path, uid, platform);
    if (status.missing) {
      entries.set(path, "absent");
      return;
    }
    const result = await withHeldConfigFile(path, async (data, stat, fd) => {
      const raw = await runPinnedGitConfig(capability, environment, signal, { kind: "file", fd });
      return {
        raw,
        fingerprint: NodeCrypto.createHash("sha256")
          .update(
            JSON.stringify([
              stat.dev,
              stat.ino,
              stat.mode,
              stat.uid,
              stat.gid,
              stat.size,
              stat.mtimeMs,
              stat.ctimeMs,
            ]),
          )
          .update(data)
          .update(raw)
          .digest("hex"),
      };
    });
    entries.set(path, result.fingerprint);
    const raw = decode(result.raw);
    if (raw && !raw.endsWith("\0")) throw new HostSignerError("untrusted");
    for (const record of raw.split("\0").filter(Boolean)) {
      const separator = record.indexOf("\n");
      if (separator < 0) continue;
      if (!/^include(?:if\..+)?\.path$/i.test(record.slice(0, separator))) continue;
      let target = record.slice(separator + 1);
      if (target.startsWith("~/")) {
        if (!environment.HOME || !NodePath.isAbsolute(environment.HOME))
          throw new HostSignerError("untrusted");
        target = `${environment.HOME}/${target.slice(2)}`;
      } else if (target.startsWith("~")) throw new HostSignerError("untrusted");
      await visit(await resolveInclude(target, NodePath.dirname(path)), depth + 1);
    }
  };
  for (const path of candidates) await visit(path, 0);
  if (effective) {
    const records = decode(effective).split("\0");
    if (records.pop() !== "" || records.length % 3) throw new HostSignerError("untrusted");
    for (let i = 0; i < records.length; i += 3) {
      const origin = records[i + 1]!;
      if (!origin.startsWith("file:")) throw new HostSignerError("untrusted");
      if (!visited.has(await resolveInclude(origin.slice(5), state.repo)))
        throw new HostSignerError("changed");
    }
  }
  return NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        gitdir,
        common,
        top,
        head,
        entries: [...entries].sort(([a], [b]) => a.localeCompare(b)),
      }),
    )
    .digest("hex");
}

declare const privateIndexBrand: unique symbol;
export interface PrivateIndexCapability {
  readonly [privateIndexBrand]: never;
}
export type PrivateGitOperation =
  | { readonly kind: "read-tree"; readonly commit: string }
  | { readonly kind: "cat-commit"; readonly commit: string }
  | { readonly kind: "cat-blob"; readonly oid: string }
  | { readonly kind: "tree-entry"; readonly commit: string; readonly path: string }
  | { readonly kind: "hash-blob" | "hash-commit"; readonly bytes: Uint8Array }
  | { readonly kind: "remove-index"; readonly path: string }
  | {
      readonly kind: "update-index";
      readonly path: string;
      readonly mode: "100644" | "100755";
      readonly oid: string;
    }
  | { readonly kind: "write-tree" }
  | { readonly kind: "committer" }
  | { readonly kind: "head" };

export class HostSignerIssuer extends Context.Service<
  HostSignerIssuer,
  {
    readonly freezeGitConfig: (
      repo: string,
    ) => Effect.Effect<FrozenHostGitConfig, HostSignerError, Scope.Scope>;
    readonly revalidateGitConfig: (
      snapshot: FrozenHostGitConfig,
    ) => Effect.Effect<void, HostSignerError>;
    readonly openPrivateIndex: (
      config: FrozenHostGitConfig,
    ) => Effect.Effect<PrivateIndexCapability, HostSignerError, Scope.Scope>;
    readonly runPrivateGit: (
      index: PrivateIndexCapability,
      operation: PrivateGitOperation,
    ) => Effect.Effect<Buffer, HostSignerError>;
    readonly acquireValidated: (
      repo: string,
      effectiveGitProgram: string,
    ) => Effect.Effect<HostSignerCapability, HostSignerError, Scope.Scope>;
    readonly revalidate: (capability: HostSignerCapability) => Effect.Effect<void, HostSignerError>;
    readonly execute: (
      capability: HostSignerCapability,
      request: HostGpgRequest,
      signal?: AbortSignal,
    ) => Effect.Effect<{ readonly output: Buffer; readonly status: string }, HostSignerError>;
  }
>()("t3/sourceControl/HostSignerCapability/HostSignerIssuer") {}

// Construct this layer at boot. Its captured environment is not provided by the repository or RPC.
export const layer = Layer.effect(
  HostSignerIssuer,
  Effect.gen(function* () {
    const environment = { ...(yield* HostProcess.Environment) };
    const serverUid = yield* HostProcess.UserId;
    const hostPlatform = yield* HostProcess.Platform;
    const acquire = (repo: string, binary: "gpg" | "gpgconf" | "git") =>
      Effect.acquireRelease(
        Effect.tryPromise({
          try: () => issueHostSignerCapability(environment.PATH ?? "", repo, binary),
          catch: (error) =>
            error instanceof HostSignerError ? error : new HostSignerError("untrusted"),
        }),
        (capability) => Effect.promise(() => closeHostSignerCapability(capability)),
      );
    const validations = new WeakMap<
      HostSignerCapability,
      { conf: HostSignerCapability; repo: string; program: string; digest: string }
    >();
    const gitConfigs = new WeakMap<
      FrozenHostGitConfig,
      { readonly repo: string; readonly digest: string; readonly git: HostSignerCapability }
    >();
    const readGitConfig = Effect.fn("HostSignerIssuer.readGitConfig")(function* (
      repo: string,
      git: HostSignerCapability,
    ) {
      if (
        !NodePath.isAbsolute(repo) ||
        Object.keys(environment).some((key) =>
          /^GIT_(?:CONFIG|DIR$|WORK_TREE$|COMMON_DIR$|INDEX_FILE$|OBJECT_DIRECTORY$|ALTERNATE_OBJECT_DIRECTORIES$|CEILING_DIRECTORIES$)/.test(
            key,
          ),
        )
      )
        return yield* Effect.fail(new HostSignerError("untrusted"));
      const query = Effect.tryPromise({
        try: (signal) => runPinnedGitConfig(git, environment, signal),
        catch: (error) =>
          error instanceof HostSignerError ? error : new HostSignerError("failed"),
      }).pipe(
        Effect.ensuring(
          Effect.promise(() => states.get(git)?.running?.promise ?? Promise.resolve()),
        ),
      );
      if (serverUid === undefined) return yield* Effect.fail(new HostSignerError("unsupported"));
      const graph = (data: Buffer | undefined) =>
        Effect.tryPromise({
          try: (signal) =>
            auditGitConfigGraph(git, environment, serverUid, hostPlatform, data, signal),
          catch: (error) =>
            error instanceof HostSignerError && error.reason === "cancelled"
              ? error
              : new HostSignerError("changed"),
        }).pipe(
          Effect.ensuring(
            Effect.promise(() => states.get(git)?.running?.promise ?? Promise.resolve()),
          ),
        );
      const files = yield* graph(undefined);
      const bytes = yield* query;
      const config = yield* Effect.try({
        try: () => parseEffectiveSigningConfig(bytes),
        catch: () => new HostSignerError("untrusted"),
      });
      const checkedFiles = yield* graph(bytes);
      if (files !== checkedFiles) return yield* Effect.fail(new HostSignerError("changed"));
      const again = yield* query;
      if (!bytes.equals(again)) return yield* Effect.fail(new HostSignerError("changed"));
      const finalFiles = yield* graph(again);
      if (files !== finalFiles) return yield* Effect.fail(new HostSignerError("changed"));
      return {
        config,
        digest: NodeCrypto.createHash("sha256").update(bytes).update(files).digest("hex"),
      };
    });
    const privateIndexes = new WeakMap<
      PrivateIndexCapability,
      {
        git: HostSignerCapability;
        config: FrozenHostGitConfig;
        dir: string;
        objects: string;
        closed: boolean;
        active: PromiseWithResolvers<void> | undefined;
      }
    >();
    const service = HostSignerIssuer.of({
      openPrivateIndex: Effect.fn("HostSignerIssuer.openPrivateIndex")(function* (config) {
        const saved = gitConfigs.get(config);
        if (!saved) return yield* Effect.fail(new HostSignerError("untrusted"));
        yield* service.revalidateGitConfig(config);
        const objectPath = yield* Effect.tryPromise({
          try: (signal) =>
            runPrivateGitProcess(
              saved.git,
              environment,
              { kind: "objects-path" },
              undefined,
              signal,
            ),
          catch: () => new HostSignerError("failed"),
        }).pipe(
          Effect.ensuring(
            Effect.promise(() => states.get(saved.git)?.running?.promise ?? Promise.resolve()),
          ),
        );
        const text = objectPath.toString("utf8").trimEnd();
        if (
          !Buffer.from(`${text}\n`).equals(objectPath) ||
          !NodePath.isAbsolute(text) ||
          text.includes(NodePath.delimiter) ||
          /[\r\n]/.test(text)
        )
          return yield* Effect.fail(new HostSignerError("untrusted"));
        const dir = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-private-index-")),
            catch: () => new HostSignerError("failed"),
          }),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        );
        yield* Effect.tryPromise({
          try: () => NodeFSP.mkdir(NodePath.join(dir, "objects"), { mode: 0o700 }),
          catch: () => new HostSignerError("failed"),
        });
        const token = Object.freeze({}) as PrivateIndexCapability;
        const workspace = {
          git: saved.git,
          config,
          dir,
          objects: text,
          closed: false,
          active: undefined as PromiseWithResolvers<void> | undefined,
        };
        privateIndexes.set(token, workspace);
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            workspace.closed = true;
            privateIndexes.delete(token);
            if (workspace.active) yield* Effect.promise(() => workspace.active!.promise);
          }),
        );
        return token;
      }),
      runPrivateGit: Effect.fn("HostSignerIssuer.runPrivateGit")(function* (index, operation) {
        const saved = privateIndexes.get(index);
        if (!saved || saved.closed || saved.active)
          return yield* Effect.fail(new HostSignerError("untrusted"));
        const active = Promise.withResolvers<void>();
        saved.active = active;
        return yield* Effect.gen(function* () {
          yield* service.revalidateGitConfig(saved.config);
          if (saved.closed) return yield* Effect.fail(new HostSignerError("cancelled"));
          return yield* Effect.tryPromise({
            try: (signal) => runPrivateGitProcess(saved.git, environment, operation, saved, signal),
            catch: (error) =>
              error instanceof HostSignerError ? error : new HostSignerError("failed"),
          }).pipe(
            Effect.ensuring(
              Effect.promise(() => states.get(saved.git)?.running?.promise ?? Promise.resolve()),
            ),
          );
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              active.resolve();
              if (saved.active === active) saved.active = undefined;
            }),
          ),
        );
      }),
      freezeGitConfig: Effect.fn("HostSignerIssuer.freezeGitConfig")(function* (repo) {
        const git = yield* acquire(repo, "git");
        const { config, digest } = yield* readGitConfig(repo, git);
        const snapshot = Object.freeze({
          digest,
          fingerprint: config.fingerprint,
          program: config.program,
        }) as FrozenHostGitConfig;
        gitConfigs.set(snapshot, { repo, digest, git });
        return snapshot;
      }),
      revalidateGitConfig: Effect.fn("HostSignerIssuer.revalidateGitConfig")(function* (snapshot) {
        const saved = gitConfigs.get(snapshot);
        if (!saved) return yield* Effect.fail(new HostSignerError("untrusted"));
        const current = yield* readGitConfig(saved.repo, saved.git);
        if (current.digest !== saved.digest)
          return yield* Effect.fail(new HostSignerError("changed"));
      }),
      execute: Effect.fn("HostSignerIssuer.execute")(function* (capability, request, signal) {
        const saved = validations.get(capability);
        if (!saved) return yield* Effect.fail(new HostSignerError("untrusted"));
        // Explicit cancellation is joined before this uninterruptible boundary returns.
        return yield* Effect.uninterruptible(
          Effect.tryPromise({
            try: async () => {
              if (signal?.aborted) throw new HostSignerError("cancelled");
              const digest = await validateHostConfiguration(
                capability,
                saved.conf,
                saved.repo,
                environment,
                saved.program,
              );
              if (digest !== saved.digest) throw new HostSignerError("changed");
              if (signal?.aborted) throw new HostSignerError("cancelled");
              return runValidatedGpg(capability, environment, request, signal);
            },
            catch: (error) =>
              error instanceof HostSignerError ? error : new HostSignerError("failed"),
          }),
        );
      }),
      revalidate: Effect.fn("HostSignerIssuer.revalidate")(function* (capability) {
        const saved = validations.get(capability);
        if (!saved) return yield* Effect.fail(new HostSignerError("untrusted"));
        const digest = yield* Effect.tryPromise({
          try: () =>
            validateHostConfiguration(
              capability,
              saved.conf,
              saved.repo,
              environment,
              saved.program,
            ),
          catch: () => new HostSignerError("changed"),
        });
        if (digest !== saved.digest) return yield* Effect.fail(new HostSignerError("changed"));
      }),
      acquireValidated: Effect.fn("HostSignerIssuer.acquireValidated")(
        function* (repo, effectiveGitProgram) {
          const gpg = yield* acquire(repo, "gpg");
          const conf = yield* acquire(repo, "gpgconf");
          const digest = yield* Effect.tryPromise({
            try: () => validateHostConfiguration(gpg, conf, repo, environment, effectiveGitProgram),
            catch: (error) =>
              error instanceof HostSignerError ? error : new HostSignerError("untrusted"),
          });
          validations.set(gpg, { conf, repo, program: effectiveGitProgram, digest });
          return gpg;
        },
      ),
    });
    return service;
  }),
);

type PinnedGitQuery =
  | { readonly kind: "effective" }
  | { readonly kind: "file"; readonly fd: number }
  | { readonly kind: "system" | "global" | "gitdir" | "common" | "toplevel" | "head" };

async function runPinnedGitConfig(
  capability: HostSignerCapability,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
  query: PinnedGitQuery = { kind: "effective" },
): Promise<Buffer> {
  const state = states.get(capability);
  if (!state || state.closed || state.running || state.binaryName !== "git")
    throw new HostSignerError("untrusted");
  if (signal.aborted) throw new HostSignerError("cancelled");
  if (
    (await winningAlias(state.capturedPath, "git")) !== state.alias ||
    (await resolveAlias(state.alias, state.repo)) !== state.canonical ||
    !same(state.stat, await state.handle.stat()) ||
    !same(state.stat, await NodeFSP.stat(state.canonical))
  )
    throw new HostSignerError("changed");
  if (signal.aborted || state.closed) throw new HostSignerError("cancelled");
  state.running = Promise.withResolvers<void>();
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const args =
        query.kind === "effective"
          ? ["config", "--includes", "--null", "--show-origin", "--show-scope", "--list"]
          : query.kind === "file"
            ? ["config", "--file", "/proc/self/fd/4", "--no-includes", "--null", "--list"]
            : query.kind === "system"
              ? ["var", "GIT_CONFIG_SYSTEM"]
              : query.kind === "global"
                ? ["var", "GIT_CONFIG_GLOBAL"]
                : query.kind === "gitdir"
                  ? ["rev-parse", "--absolute-git-dir"]
                  : query.kind === "common"
                    ? ["rev-parse", "--git-common-dir"]
                    : query.kind === "toplevel"
                      ? ["rev-parse", "--show-toplevel"]
                      : ["rev-parse", "--symbolic-full-name", "HEAD"];
      const child = NodeChildProcess.spawn("/proc/self/fd/3", args, {
        argv0: state.canonical,
        cwd: state.repo,
        env: {
          PATH: environment.PATH,
          HOME: environment.HOME,
          XDG_CONFIG_HOME: environment.XDG_CONFIG_HOME,
          LC_ALL: "C",
          GIT_TERMINAL_PROMPT: "0",
        },
        stdio:
          query.kind === "file"
            ? ["ignore", "pipe", "ignore", state.handle.fd, query.fd]
            : ["ignore", "pipe", "ignore", state.handle.fd],
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let reason: HostSignerError["reason"] | undefined;
      const stop = (why: HostSignerError["reason"]) => {
        reason ??= why;
        child.kill("SIGKILL");
      };
      const abort = () => stop("cancelled");
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(() => stop("failed"), 30_000);
      child.on("error", () => {
        reason ??= "failed";
      });
      child.stdout!.on("data", (part: Buffer) => {
        size += part.length;
        if (size > 1024 * 1024) stop("failed");
        else chunks.push(part);
      });
      child.stdout!.on("error", () => stop("failed"));
      child.on("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (reason || code !== 0) reject(new HostSignerError(reason ?? "failed"));
        else resolve(Buffer.concat(chunks));
      });
    });
  } finally {
    state.running?.resolve();
    state.running = null;
  }
}

async function runPrivateGitProcess(
  capability: HostSignerCapability,
  environment: NodeJS.ProcessEnv,
  operation: PrivateGitOperation | { readonly kind: "objects-path" },
  workspace: { readonly dir: string; readonly objects: string } | undefined,
  signal: AbortSignal,
): Promise<Buffer> {
  const state = states.get(capability);
  if (!state || state.closed || state.running || state.binaryName !== "git")
    throw new HostSignerError("untrusted");
  if (signal.aborted) throw new HostSignerError("cancelled");
  const active = Promise.withResolvers<void>();
  state.running = active;
  let file: NodeFSP.FileHandle | undefined;
  let temporary: string | undefined;
  try {
    if (
      (await winningAlias(state.capturedPath, "git")) !== state.alias ||
      (await resolveAlias(state.alias, state.repo)) !== state.canonical ||
      !same(state.stat, await state.handle.stat()) ||
      !same(state.stat, await NodeFSP.stat(state.canonical))
    )
      throw new HostSignerError("changed");
    if (signal.aborted || state.closed) throw new HostSignerError("cancelled");
    if (operation.kind !== "objects-path" && !workspace) throw new HostSignerError("untrusted");
    const validOid = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
    const validPath = (path: string) =>
      !!path &&
      !path.startsWith("/") &&
      !/[\0\r\n]/.test(path) &&
      path.split("/").every((part) => !!part && ![".", "..", ".git"].includes(part));
    let args: string[];
    switch (operation.kind) {
      case "objects-path":
        args = ["rev-parse", "--path-format=absolute", "--git-path", "objects"];
        break;
      case "head":
        args = ["rev-parse", "--verify", "HEAD"];
        break;
      case "committer":
        args = ["var", "GIT_COMMITTER_IDENT"];
        break;
      case "read-tree":
        if (!validOid(operation.commit)) throw new HostSignerError("untrusted");
        args = ["read-tree", operation.commit];
        break;
      case "cat-commit":
        if (!validOid(operation.commit)) throw new HostSignerError("untrusted");
        args = ["cat-file", "commit", operation.commit];
        break;
      case "cat-blob":
        if (!validOid(operation.oid)) throw new HostSignerError("untrusted");
        args = ["cat-file", "blob", operation.oid];
        break;
      case "tree-entry":
        if (!validOid(operation.commit) || !validPath(operation.path))
          throw new HostSignerError("untrusted");
        args = ["ls-tree", "-z", operation.commit, "--", operation.path];
        break;
      case "write-tree":
        args = ["write-tree"];
        break;
      case "update-index":
        if (
          !validOid(operation.oid) ||
          !["100644", "100755"].includes(operation.mode) ||
          !validPath(operation.path)
        )
          throw new HostSignerError("untrusted");
        args = [
          "update-index",
          "--add",
          "--cacheinfo",
          operation.mode,
          operation.oid,
          operation.path,
        ];
        break;
      case "remove-index":
        if (!validPath(operation.path)) throw new HostSignerError("untrusted");
        args = ["update-index", "--force-remove", "--", operation.path];
        break;
      case "hash-blob":
      case "hash-commit": {
        if (operation.bytes.byteLength > 16 * 1024 * 1024) throw new HostSignerError("untrusted");
        temporary = NodePath.join(workspace!.dir, `input-${NodeCrypto.randomUUID()}`);
        file = await NodeFSP.open(
          temporary,
          NodeFS.constants.O_CREAT |
            NodeFS.constants.O_EXCL |
            NodeFS.constants.O_RDWR |
            NodeFS.constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.writeFile(operation.bytes);
        } catch (error) {
          await file.close();
          await NodeFSP.unlink(temporary);
          throw error;
        }
        // The child inherits a fresh descriptor positioned at byte zero.
        await file.close();
        file = await NodeFSP.open(
          temporary,
          NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
        );
        args = [
          "hash-object",
          "--no-filters",
          "-t",
          operation.kind === "hash-commit" ? "commit" : "blob",
          "-w",
          "--stdin",
        ];
        break;
      }
    }
    if (signal.aborted || state.closed) throw new HostSignerError("cancelled");
    return await new Promise<Buffer>((resolve, reject) => {
      const child = NodeChildProcess.spawn(
        "/proc/self/fd/3",
        [
          "--no-optional-locks",
          "--no-replace-objects",
          "--no-lazy-fetch",
          "--literal-pathspecs",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.splitIndex=false",
          "-c",
          "core.untrackedCache=false",
          "-c",
          "core.sparseCheckout=false",
          "-c",
          "index.sparse=false",
          ...args,
        ],
        {
          argv0: state.canonical,
          cwd: state.repo,
          env: {
            PATH: environment.PATH,
            HOME: environment.HOME,
            XDG_CONFIG_HOME: environment.XDG_CONFIG_HOME,
            LC_ALL: "C",
            GIT_TERMINAL_PROMPT: "0",
            ...(workspace
              ? {
                  GIT_INDEX_FILE: NodePath.join(workspace.dir, "index"),
                  GIT_OBJECT_DIRECTORY: NodePath.join(workspace.dir, "objects"),
                  GIT_ALTERNATE_OBJECT_DIRECTORIES: workspace.objects,
                }
              : {}),
          },
          stdio: [file ? file.fd : "ignore", "pipe", "ignore", state.handle.fd],
        },
      );
      const chunks: Buffer[] = [];
      let size = 0;
      let reason: HostSignerError["reason"] | undefined;
      const stop = (why: HostSignerError["reason"]) => {
        reason ??= why;
        child.kill("SIGKILL");
      };
      const abort = () => stop("cancelled");
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(() => stop("failed"), 30_000);
      child.on("error", () => {
        reason ??= "failed";
      });
      child.stdout!.on("data", (part: Buffer) => {
        size += part.length;
        if (size > 16 * 1024 * 1024) stop("failed");
        else chunks.push(part);
      });
      child.stdout!.on("error", () => stop("failed"));
      child.on("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (reason || code !== 0) reject(new HostSignerError(reason ?? "failed"));
        else resolve(Buffer.concat(chunks));
      });
    });
  } finally {
    try {
      await file?.close();
      if (temporary) await NodeFSP.unlink(temporary).catch(() => {});
    } finally {
      active.resolve();
      if (state.running === active) state.running = null;
    }
  }
}

async function queryGpgconf(
  capability: HostSignerCapability,
  name: "sysconfdir" | "agent-socket",
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const state = states.get(capability);
  if (!state || state.closed || state.running || state.binaryName !== "gpgconf")
    throw new HostSignerError("untrusted");
  state.running = Promise.withResolvers<void>();
  try {
    if (
      (await winningAlias(state.capturedPath, "gpgconf")) !== state.alias ||
      (await resolveAlias(state.alias, state.repo)) !== state.canonical ||
      !same(state.stat, await state.handle.stat())
    )
      throw new HostSignerError("changed");
    return await new Promise<string>((resolve, reject) => {
      const child = NodeChildProcess.spawn("/proc/self/fd/3", ["--list-dirs", name], {
        argv0: state.canonical,
        env: { HOME: environment.HOME, GNUPGHOME: environment.GNUPGHOME, LC_ALL: "C" },
        stdio: ["ignore", "pipe", "ignore", state.handle.fd],
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let failed = false;
      const timer = setTimeout(() => {
        failed = true;
        child.kill("SIGKILL");
      }, 30_000);
      child.stdout!.on("data", (part: Buffer) => {
        size += part.length;
        if (size > 4096) {
          failed = true;
          child.kill("SIGKILL");
        } else chunks.push(part);
      });
      child.on("error", () => {
        failed = true;
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (failed || code !== 0) return reject(new HostSignerError("failed"));
        const raw = Buffer.concat(chunks);
        const value = raw.toString("utf8").trimEnd();
        if (
          !Buffer.from(`${value}\n`).equals(raw) ||
          !NodePath.isAbsolute(value) ||
          /[\0\r\n]/.test(value)
        )
          return reject(new HostSignerError("untrusted"));
        resolve(value);
      });
    });
  } finally {
    state.running?.resolve();
    state.running = null;
  }
}
async function validateHostConfiguration(
  gpg: HostSignerCapability,
  conf: HostSignerCapability,
  repo: string,
  environment: NodeJS.ProcessEnv,
  gitProgram: string,
): Promise<string> {
  const state = states.get(gpg);
  if (!state || state.closed) throw new HostSignerError("untrusted");
  if (
    (await winningAlias(state.capturedPath, "gpg")) !== state.alias ||
    (await resolveAlias(state.alias, repo)) !== state.canonical ||
    !same(state.stat, await state.handle.stat()) ||
    !same(state.stat, await NodeFSP.stat(state.canonical))
  )
    throw new HostSignerError("changed");
  const selected =
    gitProgram === "gpg" ? await winningAlias(state.capturedPath, "gpg") : gitProgram;
  if (!NodePath.isAbsolute(selected) || (await resolveAlias(selected, repo)) !== state.canonical)
    throw new HostSignerError("untrusted");
  const home =
    environment.GNUPGHOME ?? (environment.HOME ? NodePath.join(environment.HOME, ".gnupg") : "");
  if (
    !NodePath.isAbsolute(home) ||
    NodePath.resolve(home) !== home ||
    (await NodeFSP.realpath(home)) !== home
  )
    throw new HostSignerError("untrusted");
  const repository = await NodeFSP.realpath(repo);
  if (home === repository || home.startsWith(`${repository}/`))
    throw new HostSignerError("untrusted");
  const info = await NodeFSP.lstat(home);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new HostSignerError("untrusted");
  const system = await queryGpgconf(conf, "sysconfdir", environment);
  try {
    await protectedChain(system);
    if (!(await NodeFSP.stat(system)).isDirectory()) throw new HostSignerError("untrusted");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A missing final directory is safe only while its parent remains protected.
    await protectedChain(NodePath.dirname(system));
  }
  const socket = await queryGpgconf(conf, "agent-socket", environment);
  const socketInfo = await NodeFSP.lstat(socket);
  if (!socketInfo.isSocket() || socketInfo.uid !== process.getuid?.())
    throw new HostSignerError("untrusted");
  const snapshot: string[] = [
    state.canonical,
    home,
    system,
    socket,
    `${info.dev}:${info.ino}:${info.mode}`,
    `${socketInfo.dev}:${socketInfo.ino}:${socketInfo.mode}`,
  ];
  for (const directory of [system, home]) {
    let names: string[];
    try {
      names = await NodeFSP.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && directory === system) continue;
      throw error;
    }
    for (const name of names.filter((n) => /^(?:gpg|common)\.conf(?:-[0-9.]+)?$/.test(n)).sort()) {
      const path = NodePath.join(directory, name);
      const file = await NodeFSP.open(
        path,
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
      );
      try {
        const st = await file.stat();
        if (
          !st.isFile() ||
          st.size > 65536 ||
          st.uid !== (directory === system ? 0 : process.getuid?.()) ||
          (st.mode & 0o022) !== 0
        )
          throw new HostSignerError("untrusted");
        const data = await file.readFile();
        if (!same(st, await file.stat()) || data.length !== st.size)
          throw new HostSignerError("changed");
        snapshot.push(
          `${path}:${st.dev}:${st.ino}:${st.mode}:${NodeCrypto.createHash("sha256").update(data).digest("hex")}`,
        );
        if (
          data.length > 65536 ||
          data.includes(0) ||
          data
            .toString("utf8")
            .split("\n")
            .some((line) => line.trim() !== "" && !line.trimStart().startsWith("#"))
        )
          throw new HostSignerError("untrusted");
      } finally {
        await file.close();
      }
    }
  }
  return NodeCrypto.createHash("sha256").update(snapshot.join("\0")).digest("hex");
}

async function runValidatedGpg(
  capability: HostSignerCapability,
  environment: NodeJS.ProcessEnv,
  request: HostGpgRequest,
  signal?: AbortSignal,
) {
  const state = states.get(capability);
  if (!state || state.closed || state.running || state.binaryName !== "gpg")
    throw new HostSignerError("untrusted");
  if (signal?.aborted) throw new HostSignerError("cancelled");
  if ("fingerprint" in request && !/^(?:[0-9A-F]{40}|[0-9A-F]{64})$/.test(request.fingerprint))
    throw new HostSignerError("untrusted");
  if ("data" in request && request.data.byteLength > 16 * 1024 * 1024)
    throw new HostSignerError("untrusted");
  if (request.kind === "verify" && request.signature.byteLength > 1024 * 1024)
    throw new HostSignerError("untrusted");
  if (
    request.kind === "sign" &&
    (request.passphrase.byteLength === 0 ||
      request.passphrase.byteLength > 4096 ||
      request.passphrase.includes(10) ||
      request.passphrase.includes(13))
  )
    throw new HostSignerError("untrusted");
  const home = environment.GNUPGHOME ?? NodePath.join(environment.HOME!, ".gnupg");
  let args: string[];
  let stdin: Uint8Array = Buffer.alloc(0);
  let extra: Uint8Array | undefined;
  let secret: Buffer | undefined;
  switch (request.kind) {
    case "list":
      args = [
        "--with-colons",
        "--with-keygrip",
        "--fixed-list-mode",
        "--list-secret-keys",
        request.fingerprint,
      ];
      break;
    case "export":
      args = ["--export", request.fingerprint];
      break;
    case "sign":
      args = [
        "--pinentry-mode",
        "loopback",
        "--passphrase-fd",
        "3",
        "--status-fd",
        "4",
        "--local-user",
        `${request.fingerprint}!`,
        "--armor",
        "--detach-sign",
      ];
      stdin = request.data;
      secret = Buffer.alloc(request.passphrase.byteLength + 1);
      secret.set(request.passphrase);
      secret[secret.length - 1] = 10;
      extra = secret;
      break;
    case "verify":
      args = ["--enable-special-filenames", "--status-fd", "4", "--verify", "-", "-&3"];
      stdin = request.signature;
      extra = request.data;
      break;
  }
  state.running = Promise.withResolvers<void>();
  try {
    return await new Promise<{ output: Buffer; status: string }>((resolve, reject) => {
      let child: NodeChildProcess.ChildProcess;
      try {
        child = NodeChildProcess.spawn(
          "/proc/self/fd/5",
          ["--no-autostart", "--homedir", home, "--batch", "--no-tty", ...args],
          {
            argv0: state.canonical,
            env: { HOME: environment.HOME, GNUPGHOME: home, LC_ALL: "C" },
            stdio: ["pipe", "pipe", "ignore", "pipe", "pipe", state.handle.fd],
          },
        );
      } catch {
        reject(new HostSignerError("failed"));
        return;
      }
      const out: Buffer[] = [],
        status: Buffer[] = [];
      let outSize = 0,
        statusSize = 0;
      let failure: HostSignerError["reason"] | undefined;
      const stop = (reason: HostSignerError["reason"]) => {
        failure ??= reason;
        child.kill("SIGKILL");
      };
      const abort = () => stop("cancelled");
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(() => stop("failed"), 30_000);
      child.on("error", () => {
        failure ??= "failed";
      });
      child.stdout!.on("data", (part: Buffer) => {
        outSize += part.length;
        if (outSize > 1024 * 1024) stop("failed");
        else out.push(part);
      });
      const pipe = child.stdio[3] as NodeStream.Writable;
      const statusPipe = child.stdio[4] as NodeStream.Readable;
      statusPipe.on("data", (part: Buffer) => {
        statusSize += part.length;
        if (statusSize > 1024 * 1024) stop("failed");
        else status.push(part);
      });
      for (const stream of [child.stdin!, child.stdout!, pipe, statusPipe])
        stream.on("error", () => {
          failure ??= "failed";
        });
      pipe.end(extra);
      child.stdin!.end(stdin);
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (failure || code !== 0) reject(new HostSignerError(failure ?? "failed"));
        else
          resolve({ output: Buffer.concat(out), status: Buffer.concat(status).toString("utf8") });
      });
    });
  } finally {
    secret?.fill(0);
    state.running?.resolve();
    state.running = null;
  }
}
