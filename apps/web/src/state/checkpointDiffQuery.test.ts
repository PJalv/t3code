import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveCheckpointDiffQueryKind } from "./checkpointDiffQuery";

const baseTarget = {
  environmentId: EnvironmentId.make("environment-local"),
  threadId: ThreadId.make("thread-1"),
  fromTurnCount: 0,
  toTurnCount: 1,
  ignoreWhitespace: false,
};

describe("resolveCheckpointDiffQueryKind", () => {
  it("uses the turn endpoint for a turn-scoped first-turn diff", () => {
    expect(
      resolveCheckpointDiffQueryKind(
        { ...baseTarget, cacheScope: "turn:turn-1:inline-file-change" },
        true,
      ),
    ).toBe("turn");
  });

  it("keeps the full-thread endpoint for a full history range", () => {
    expect(resolveCheckpointDiffQueryKind(baseTarget, true)).toBe("full-thread");
  });
});
