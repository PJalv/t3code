import type { CheckpointDiffTarget } from "@t3tools/client-runtime/state/threads";

export function resolveCheckpointDiffQueryKind(
  target: CheckpointDiffTarget,
  enabled: boolean,
): "full-thread" | "turn" | null {
  if (!enabled) {
    return null;
  }
  if (target.fromTurnCount === 0 && !target.cacheScope?.startsWith("turn:")) {
    return "full-thread";
  }
  return "turn";
}
