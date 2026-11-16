import type { PullRequestListInput, PullRequestListStatsInput } from "@t3tools/contracts";
import {
  usePullRequestList,
  usePullRequestListStats,
  type EnvironmentQueryTarget,
} from "~/state/pullRequests";

const NO_TARGETS: readonly never[] = [];

export function useRoutePullRequestList(
  gerritActive: boolean,
  targets: ReadonlyArray<EnvironmentQueryTarget<PullRequestListInput>>,
) {
  return usePullRequestList(gerritActive ? NO_TARGETS : targets);
}

export function useRoutePullRequestListStats(
  gerritActive: boolean,
  targets: ReadonlyArray<EnvironmentQueryTarget<PullRequestListStatsInput>>,
) {
  return usePullRequestListStats(gerritActive ? NO_TARGETS : targets);
}
