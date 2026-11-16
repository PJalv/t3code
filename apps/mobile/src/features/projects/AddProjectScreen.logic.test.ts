import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { EnvironmentId, GerritInstallationId, GerritProjectName } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { gerritCloneDestination, resolveAddProjectEnvironment } from "./AddProjectScreen.logic";

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
