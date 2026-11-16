import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  GerritChangeId,
  GerritChangeNumber,
  GerritChangeRevision,
  GerritConfigureInput,
  GerritConnectionError,
  GerritReadError,
  GerritInstallationId,
  GerritPatchSetNumber,
  GerritRepositoryScope,
  GitCommitOid,
} from "./gerrit.ts";

const decodeReadError = Schema.decodeUnknownSync(GerritReadError);
const decodeConnectionError = Schema.decodeUnknownSync(GerritConnectionError);
const decodeScope = Schema.decodeUnknownSync(GerritRepositoryScope);
const decodeInstallation = Schema.decodeUnknownSync(GerritInstallationId);
const decodeRevision = Schema.decodeUnknownSync(GerritChangeRevision);
const isInstallation = Schema.is(GerritInstallationId);
const isChangeId = Schema.is(GerritChangeId);
const isCommitOid = Schema.is(GitCommitOid);
const isChangeNumber = Schema.is(GerritChangeNumber);
const isPatchSetNumber = Schema.is(GerritPatchSetNumber);
const isRevision = Schema.is(GerritChangeRevision);

const scope = {
  installation: "https://review.example:8443/Review/",
  project: "Team/Repo",
  branch: "Release/Next",
};

describe("native Gerrit wire errors", () => {
  it("round-trips bounded errors without raw transport or credential data", () => {
    const read = decodeReadError({
      _tag: "GerritReadError",
      reason: "authentication",
      status: 401,
      cause: "fixture-secret",
      body: "private body",
    });
    const connection = decodeConnectionError({
      _tag: "GerritConnectionError",
      reason: "credentials-invalid",
      credentials: "fixture-secret",
    });
    expect(JSON.stringify([read, connection])).not.toContain("fixture-secret");
    expect(JSON.stringify(read)).not.toContain("private body");
    expect(read.message).toBe("Gerrit read failed (authentication).");
    expect(connection.message).toBe("Gerrit connection failed (credentials-invalid).");
  });
});

describe("native Gerrit identity", () => {
  it("preserves the canonical installation mount, project and branch case", () => {
    expect(decodeScope(scope)).toEqual(scope);
    expect(decodeScope({ ...scope, project: "Repo" }).project).toBe("Repo");
    expect(decodeInstallation("http://review.example:8080/Review/")).toBe(
      "http://review.example:8080/Review/",
    );
  });

  it.each([
    "ssh://review.example/Review/",
    "https://user:password@review.example/Review/",
    "https://review.example/Review/?token=secret",
    "https://review.example/Review/#fragment",
    "https://review.example/Review/?",
    "https://review.example/Review/#",
    "https://REVIEW.example/Review/",
    "https://review.example/Review",
  ])("rejects noncanonical or credential-bearing installation %s", (installation) => {
    expect(isInstallation(installation)).toBe(false);
  });

  it("keeps a Change-Id, commit OID and observed numbers distinct", () => {
    const changeId = `I${"a".repeat(40)}`;
    const commit = "b".repeat(40);
    const record = {
      key: { ...scope, changeId },
      number: 502,
      revision: { commit, patchSet: 7 },
    };
    expect(decodeRevision(record)).toEqual(record);
    expect(isChangeId(commit)).toBe(false);
    expect(isCommitOid(changeId)).toBe(false);
    expect(isCommitOid("b".repeat(64))).toBe(true);
    expect(isChangeId(`I${"0".repeat(40)}`)).toBe(false);
    expect(isChangeNumber(0)).toBe(false);
    expect(isPatchSetNumber(1.5)).toBe(false);
    expect(isRevision({ number: 502, headRefName: "feature" })).toBe(false);
  });
});

const decodeConfigureInput = Schema.decodeUnknownSync(GerritConfigureInput);

it("accepts a settings-only configure request without credential bytes", () => {
  const config = { installation: "https://review.example/", authMode: "http-basic", bindings: [] };
  expect(decodeConfigureInput({ config })).toEqual({ config });
});
