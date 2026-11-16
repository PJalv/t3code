import {
  EnvironmentId,
  GerritChangeKey,
  GerritChangeNumber,
  GerritInstallationId,
} from "@t3tools/contracts";
import { Schema } from "effect";

const GerritRouteChange = Schema.Struct({ key: GerritChangeKey, number: GerritChangeNumber });
const GerritRouteSource = Schema.Struct({
  environmentId: EnvironmentId,
  installation: GerritInstallationId,
});
const isGerritRouteSource = Schema.is(GerritRouteSource);
const isGerritRouteChange = Schema.is(GerritRouteChange);
export type GerritRouteChange = typeof GerritRouteChange.Type;
export type GerritRouteState = typeof GerritRouteSource.Type & {
  readonly change?: GerritRouteChange;
};

export function gerritRouteBack(state: GerritRouteState): GerritRouteState | undefined {
  if (!state.change) return undefined;
  const { change: _change, ...list } = state;
  return list;
}

export function parseGerritRoute(raw: unknown): GerritRouteState | undefined {
  if (!isGerritRouteSource(raw)) return undefined;
  const change = (raw as Record<string, unknown>).change;
  // A partial or conflicting change must not select a different change.
  return {
    environmentId: raw.environmentId,
    installation: raw.installation,
    ...(isGerritRouteChange(change) && change.key.installation === raw.installation
      ? { change }
      : {}),
  };
}
