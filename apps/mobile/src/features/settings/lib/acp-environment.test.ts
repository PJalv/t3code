import type { ProviderInstanceEnvironmentVariable, SecretReference } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendNewEnvironmentVariables,
  buildEnvironmentVariables,
  environmentEditorSeed,
  parseEnvironmentOverrides,
} from "./acp-environment";

const reference: SecretReference = {
  provider: "personal" as SecretReference["provider"],
  reference: "op://Vault/Maki/TOKEN",
};

const save = (
  existing: ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined,
  env: string,
) => {
  const overrides = parseEnvironmentOverrides(env);
  return appendNewEnvironmentVariables(buildEnvironmentVariables(existing, overrides), overrides);
};

describe("custom ACP environment editing", () => {
  it("keeps an untouched secret reference when only other fields are saved", () => {
    const existing: ProviderInstanceEnvironmentVariable[] = [
      { name: "API_TOKEN", value: reference, sensitive: true },
      { name: "PLAIN", value: "plain", sensitive: false },
    ];

    expect(save(existing, environmentEditorSeed(existing))).toEqual([
      { name: "API_TOKEN", value: reference, sensitive: true },
      { name: "PLAIN", value: "plain", sensitive: false },
    ]);
  });

  it("round-trips a reference through the editor JSON without flattening it", () => {
    const seed = environmentEditorSeed([{ name: "API_TOKEN", value: reference, sensitive: true }]);

    expect(JSON.parse(seed)).toEqual({ API_TOKEN: reference });
    expect(parseEnvironmentOverrides(seed)).toEqual({ API_TOKEN: reference });
  });

  it("replaces a reference when the user supplies a plain value", () => {
    const existing: ProviderInstanceEnvironmentVariable[] = [
      { name: "API_TOKEN", value: reference, sensitive: true },
    ];

    const saved = save(existing, JSON.stringify({ API_TOKEN: "plain-now" }));

    expect(saved).toEqual([{ name: "API_TOKEN", value: "plain-now", sensitive: true }]);
  });

  it("deletes a reference row the user removed from the editor", () => {
    const existing: ProviderInstanceEnvironmentVariable[] = [
      { name: "KEEP", value: reference, sensitive: true },
      { name: "DROP", value: reference, sensitive: true },
    ];

    const saved = save(existing, JSON.stringify({ KEEP: reference }));

    expect(saved).toEqual([{ name: "KEEP", value: reference, sensitive: true }]);
  });

  it("preserves a redacted value that has no editable form", () => {
    const existing: ProviderInstanceEnvironmentVariable[] = [
      { name: "SECRET", value: "", sensitive: true, valueRedacted: true },
    ];

    const saved = save(existing, environmentEditorSeed(existing));

    expect(saved).toEqual([{ name: "SECRET", value: "", sensitive: true, valueRedacted: true }]);
  });

  it("drops the stale redacted flag when the user supplies a new value", () => {
    const existing: ProviderInstanceEnvironmentVariable[] = [
      { name: "SECRET", value: "", sensitive: true, valueRedacted: true },
    ];

    const saved = save(existing, JSON.stringify({ SECRET: "typed" }));

    expect(saved).toEqual([{ name: "SECRET", value: "typed", sensitive: true }]);
  });

  it("adds a new variable that names no existing entry", () => {
    const existing: ProviderInstanceEnvironmentVariable[] = [
      { name: "API_TOKEN", value: reference, sensitive: true },
    ];

    const saved = save(existing, JSON.stringify({ API_TOKEN: reference, ADDED: "fresh" }));

    expect(saved).toEqual([
      { name: "API_TOKEN", value: reference, sensitive: true },
      { name: "ADDED", value: "fresh", sensitive: true },
    ]);
  });

  it("does not shadow an existing reference with a same-named new entry", () => {
    const existing: ProviderInstanceEnvironmentVariable[] = [
      { name: "API_TOKEN", value: reference, sensitive: true },
    ];

    const saved = save(existing, environmentEditorSeed(existing));

    expect(saved).toHaveLength(1);
    expect(saved[0]!.value).toEqual(reference);
  });
});
