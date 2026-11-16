import { expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";

import { GerritDirectToolkit } from "./tools.ts";

it("exports an object root schema for every Gerrit tool, as MCP registration requires", () => {
  for (const tool of Object.values(GerritDirectToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly anyOf?: unknown;
    };
    expect(schema.type, tool.name).toBe("object");
    expect(schema.anyOf, tool.name).toBeUndefined();
  }
});
