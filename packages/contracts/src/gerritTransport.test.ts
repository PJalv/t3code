import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  GerritUploadCommitInput,
  GerritUploadCommitResult,
  PullRequestGerritCommandInput,
} from "./rpc.ts";

const decodeCommand = Schema.decodeUnknownSync(PullRequestGerritCommandInput);
const encodeCommand = Schema.encodeSync(PullRequestGerritCommandInput);
const decodeUpload = Schema.decodeUnknownSync(GerritUploadCommitInput);
const encodeUpload = Schema.encodeSync(GerritUploadCommitInput);
const decodeResult = Schema.decodeUnknownSync(GerritUploadCommitResult);
const encodeResult = Schema.encodeSync(GerritUploadCommitResult);

describe("Gerrit transport schemas", () => {
  it("round trips each command with its payload", () => {
    const ref = { projectId: "project", repository: "org/repo", number: 42 };
    for (const command of [
      { command: "setVotes", payload: { votes: { "Code-Review": 2 } } },
      { command: "setTopic", payload: { topic: null } },
      { command: "setPrivate", payload: { isPrivate: true } },
      { command: "setCommitMessage", payload: { message: "subject" } },
      { command: "rebaseChain", payload: { base: "main" } },
      { command: "cherryPick", payload: { destination: "stable" } },
    ]) {
      const input = { ...ref, ...command };
      const decoded = decodeCommand(input);
      expect(decodeCommand(encodeCommand(decoded))).toEqual(input);
    }
  });
  it("round trips uploads and their result", () => {
    const input = { cwd: "/repo", upload: { kind: "new", branch: "main" } };
    const decoded = decodeUpload(input);
    expect(decodeUpload(encodeUpload(decoded))).toEqual(input);
    const result = {
      result: { pushed: true, changeNumber: 42 },
      change: null,
      rereadError: "unavailable",
    };
    const decodedResult = decodeResult(result);
    expect(decodeResult(encodeResult(decodedResult))).toEqual(result);
    expect(() =>
      decodeUpload({
        cwd: "/repo",
        upload: { kind: "patch-set", number: 1, url: "https://example.test/1" },
      }),
    ).toThrow();
  });
});
