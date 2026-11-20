export {
  gerritConnectionConfigFromFields,
  gerritCredentialSaveMode,
  gerritTerminalGitCommandTemplate,
} from "./gerritReview.ts";
import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";

import { Atom } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";
import { invalidateCachedVcsRefs } from "./vcsRefInvalidation.ts";

export function createSourceControlEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const gerritGeneration = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.keepAlive),
  );
  const refreshGerrit = ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
    gerritGeneration(environmentId);
  const invalidateGerrit = (
    target: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() =>
      registry.update(gerritGeneration(target.environmentId), (generation) => generation + 1),
    );
  return {
    refreshGerrit: (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) => {
      registry.update(gerritGeneration(environmentId), (generation) => generation + 1);
    },
    gerritHook: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:gerrit:hook",
      tag: WS_METHODS.gerritHook,
      refreshTrigger: refreshGerrit,
    }),
    gerritInstallHook: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:gerrit:installhook",
      tag: WS_METHODS.gerritInstallHook,
      onSettled: invalidateGerrit,
    }),
    gerritSearchProjects: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:gerrit:search-projects",
      tag: WS_METHODS.gerritSearchProjects,
    }),
    gerritConnections: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:gerrit:connections",
      tag: WS_METHODS.gerritConnections,
      refreshTrigger: refreshGerrit,
    }),
    gerritDeliveryCheckout: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:gerrit:delivery-checkout",
      tag: WS_METHODS.gerritDeliveryCheckout,
      refreshTrigger: refreshGerrit,
      staleTimeMs: 0,
    }),
    gerritConfigure: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:gerrit:configure",
      tag: WS_METHODS.gerritConfigure,
      scheduler: commandScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    gerritTest: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:gerrit:test",
      tag: WS_METHODS.gerritTest,
    }),
    gerritRemove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:gerrit:remove",
      tag: WS_METHODS.gerritRemove,
      scheduler: commandScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    gerritRemoveCredentials: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:gerrit:remove-credentials",
      tag: WS_METHODS.gerritRemoveCredentials,
      scheduler: commandScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    gerritSigningPassphrase: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:gerrit:signing-passphrase",
      tag: WS_METHODS.gerritSigningPassphrase,
      refreshTrigger: refreshGerrit,
    }),
    gerritSetSigningPassphrase: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:gerrit:set-signing-passphrase",
      tag: WS_METHODS.gerritSetSigningPassphrase,
      scheduler: commandScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    discovery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:source-control-discovery",
      tag: WS_METHODS.serverDiscoverSourceControl,
    }),
    appAccess: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:app-access",
      tag: WS_METHODS.sourceControlAppAccess,
    }),
    // One check, as after cloning, where no view keeps the query mounted.
    checkAppAccess: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:check-app-access",
      tag: WS_METHODS.sourceControlAppAccess,
    }),
    checkStarred: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:check-starred",
      tag: WS_METHODS.sourceControlStarred,
    }),
    star: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:star",
      tag: WS_METHODS.sourceControlStar,
    }),
    repository: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:repository",
      tag: WS_METHODS.sourceControlLookupRepository,
    }),
    // Clone-backed project creation. The RPC returns once the project exists
    // and the clone runs in the background; `projectClones` carries progress.
    startProjectClone: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:project-clone-start",
      tag: WS_METHODS.projectCloneStart,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    // Cancel and retry share the start queue so a double click cannot race
    // two actions against the same clone.
    cancelProjectClone: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:project-clone-cancel",
      tag: WS_METHODS.projectCloneCancel,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    retryProjectClone: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:project-clone-retry",
      tag: WS_METHODS.projectCloneRetry,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    // Unscheduled: a pending sign-in waits on the user for minutes and must not hold up clones.
    startSignIn: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:sign-in-start",
      tag: WS_METHODS.sourceControlSignInStart,
    }),
    waitForSignIn: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:sign-in-wait",
      tag: WS_METHODS.sourceControlSignInWait,
    }),
    cancelSignIn: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:sign-in-cancel",
      tag: WS_METHODS.sourceControlSignInCancel,
    }),
    projectClones: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:source-control:project-clones",
      tag: WS_METHODS.subscribeProjectClones,
    }),
    publishRepository: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:publish-repository",
      tag: WS_METHODS.sourceControlPublishRepository,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
      onSettled: (target, registry) =>
        invalidateCachedVcsRefs(registry, {
          environmentId: target.environmentId,
          cwd: target.input.cwd,
        }),
    }),
  };
}
