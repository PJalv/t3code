import { type ProviderInstanceEnvironmentVariable, SecretReference } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeEnvironmentValue = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.Union([Schema.String, SecretReference])),
);

/**
 * The Environment JSON field is keyed by variable name. A plain string is a
 * value; an object carrying `provider`/`reference` is a secret reference, which
 * the editor round-trips as JSON instead of flattening to a string.
 */
export type EnvironmentOverrides = Readonly<Record<string, string | SecretReference>>;

/** Parses the editor's Environment JSON, rejecting values that are neither. */
export const parseEnvironmentOverrides = (env: string): EnvironmentOverrides =>
  decodeEnvironmentValue(JSON.parse(env));

export const formatEnvironmentOverride = (value: string | SecretReference): string =>
  typeof value === "string" ? value : `${value.provider}:${value.reference}`;

/**
 * Seeds the editor field from an instance's environment. Redacted values have no
 * readable form, so they are omitted here and preserved by the merge instead.
 */
export const environmentEditorSeed = (
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined,
): string =>
  JSON.stringify(
    Object.fromEntries(
      (environment ?? [])
        .filter((entry) => !entry.valueRedacted)
        .map((entry) => [entry.name, entry.value]),
    ),
  );

/**
 * Merges the editor's overrides into an instance's environment. The editor text
 * is the whole truth for readable entries, so omitting one deletes it; only a
 * redacted value, which has no text form, survives untouched.
 */
export const buildEnvironmentVariables = (
  existing: ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined,
  overrides: EnvironmentOverrides,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> =>
  (existing ?? []).flatMap((entry) => {
    if (Object.hasOwn(overrides, entry.name)) {
      return [{ name: entry.name, value: overrides[entry.name]!, sensitive: entry.sensitive }];
    }
    return entry.valueRedacted ? [entry] : [];
  });

/** Adds overrides that name no existing entry, leaving preserved redactions alone. */
export const appendNewEnvironmentVariables = (
  variables: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  overrides: EnvironmentOverrides,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> => {
  const known = new Set(variables.map((entry) => entry.name));
  const added = Object.entries(overrides)
    .filter(([name]) => !known.has(name))
    .map(([name, value]) => ({ name, value, sensitive: true }));
  return [...variables, ...added];
};
