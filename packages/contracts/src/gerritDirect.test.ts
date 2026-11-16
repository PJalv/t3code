import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  GerritDirectAction,
  GerritDirectTarget,
  GerritDirectUploadInput,
  gerritDirectDecodeOptions,
} from "./gerritDirect.ts";

const decodeTarget = Schema.decodeUnknownEffect(GerritDirectTarget);
const decodeAction = Schema.decodeUnknownEffect(GerritDirectAction);
const decodeUpload = Schema.decodeUnknownEffect(GerritDirectUploadInput);
const decode = (value: unknown) => decodeTarget(value, gerritDirectDecodeOptions);
const action = (value: unknown) => decodeAction(value, gerritDirectDecodeOptions);
const upload = (value: unknown) => decodeUpload(value, gerritDirectDecodeOptions);

describe("Gerrit direct schemas", () => {
  it.effect("requires exactly one target and rejects unknown fields", () =>
    Effect.gen(function* () {
      expect(yield* decode({ number: 42 })).toEqual({ number: 42 });
      expect(yield* decode({ url: "https://review.example/c/project/+/42" })).toEqual({
        url: "https://review.example/c/project/+/42",
      });
      for (const value of [
        {},
        { number: 1, url: "https://example.com" },
        { number: 1, extra: true },
        { number: 0 },
      ]) {
        expect((yield* Effect.result(decode(value)))._tag).toBe("Failure");
      }
    }),
  );
  it.effect("decodes actions and uploads and rejects extra fields", () =>
    Effect.gen(function* () {
      expect(yield* action({ kind: "review", labels: { "Code-Review": 1 } })).toEqual({
        kind: "review",
        labels: { "Code-Review": 1 },
      });
      expect(yield* upload({ kind: "new", branch: "main" })).toEqual({
        kind: "new",
        branch: "main",
      });
      expect((yield* Effect.result(upload({ kind: "patch-set", number: 1, url: "x" })))._tag).toBe(
        "Failure",
      );
      expect((yield* Effect.result(action({ kind: "submit", extra: 1 })))._tag).toBe("Failure");
    }),
  );
});
