import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { EnvironmentId, GerritInstallationId, GerritProjectName } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { newTaskFlowKey } from "../threads/new-task-flow-state";
import {
  chooserDraftKey,
  gerritCloneDestination,
  resolveAddProjectEnvironment,
} from "./AddProjectScreen.logic";

it.each(["http", "ssh"] as const)(
  "preserves the selected installation for %s Gerrit selection",
  (transport) => {
    const match = {
      installation: GerritInstallationId.make("https://review.example/"),
      project: GerritProjectName.make("team/project"),
      httpUrl: "https://review.example/team/project",
      sshUrl: "ssh://review.example/team/project",
      ...(transport === "ssh" ? { preferredTransport: "ssh" as const } : {}),
    };
    expect(gerritCloneDestination(match)).toMatchObject({
      remoteUrl: transport === "ssh" ? match.sshUrl : match.httpUrl,
      gerritInstallation: match.installation,
      gerritProject: match.project,
    });
  },
);

const ENVIRONMENT_A = EnvironmentId.make("environment-a");
const ENVIRONMENT_B = EnvironmentId.make("environment-b");

function environment(environmentId: EnvironmentId, connectionState: EnvironmentConnectionPhase) {
  return { environmentId, connectionState };
}

describe("resolveAddProjectEnvironment", () => {
  it("does not redirect an explicit unavailable environment to another environment", () => {
    expect(
      resolveAddProjectEnvironment(
        [environment(ENVIRONMENT_A, "offline"), environment(ENVIRONMENT_B, "connected")],
        ENVIRONMENT_A,
      ),
    ).toBeNull();
  });
});

describe("chooserDraftKey", () => {
  const home = { key: "home", name: "Home" };
  const draftRoute = { key: "thread", name: "Thread", params: { draft: { requestId: "r1" } } };
  const chooser = { key: "chooser", name: "NewTaskProject" };
  const addProject = [
    { key: "add", name: "AddProject" },
    { key: "local", name: "AddProjectLocal" },
  ];
  const flowDraftKeys = new Map([[newTaskFlowKey(draftRoute), "new-task:typed"]]);
  const readFlowDraftKey = (flowKey: string) => flowDraftKeys.get(flowKey) ?? null;

  it("picks the added project for the draft whose chooser opened Add project", () => {
    expect(chooserDraftKey([home, draftRoute, chooser, ...addProject], readFlowDraftKey)).toBe(
      "new-task:typed",
    );
    const savedChooser = { ...chooser, params: { draftId: "new-task:saved" } };
    expect(chooserDraftKey([home, savedChooser, ...addProject], readFlowDraftKey)).toBe(
      "new-task:saved",
    );
  });

  it("picks no draft when Add project opened outside the chooser", () => {
    expect(chooserDraftKey([home, draftRoute, ...addProject], readFlowDraftKey)).toBeNull();
  });
});
