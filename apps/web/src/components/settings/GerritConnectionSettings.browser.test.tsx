import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { GerritConnectionSettings } from "./GerritConnectionSettings";
import "../../index.css";

vi.mock(import("../../state/sourceControl"), () => ({
  sourceControlEnvironment: {
    gerritConnections: () => "connections",
    gerritSigningPassphrase: () => "signing",
    gerritConfigure: { permissionAtom: () => true },
    gerritSetSigningPassphrase: { permissionAtom: () => true },
  } as never,
}));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => true) as never,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() =>
    vi.fn(async () => ({
      _tag: "Success",
      value: { account: { _account_id: 7 }, version: { kind: "observed", value: "3.13.1" } },
    }))) as never,
}));
vi.mock(import("../../state/query"), () => ({
  useEnvironmentQuery: ((query: string) => ({
    isSuccess: true,
    isPending: false,
    error: null,
    refresh: vi.fn(),
    data:
      query === "connections"
        ? ["https://review.example.com/", "https://other.example.com/"].map((installation) => ({
            config: { installation },
            credentialPresent: true,
          }))
        : { present: false },
  })) as never,
}));
vi.mock(import("./GerritHookSetup"), () => ({ GerritHookSetup: () => <></> }));
vi.mock(import("./settingsLayout"), () => ({
  SettingsRow: ({ title, control }) => (
    <div>
      {title}
      {control}
    </div>
  ),
}));

const environmentId = EnvironmentId.make("test-environment");

it("shows a connection test result under the server that was tested", async () => {
  await using screen = await render(
    <GerritConnectionSettings environmentId={environmentId} onSaved={() => {}} />,
  );
  await screen.getByRole("button", { name: "Test connection", exact: true }).nth(1).click();

  const result = screen.getByRole("status").filter({ hasText: "Verified account 7" });
  await expect.element(result).toBeVisible();
  expect(screen.getByRole("status").all()).toHaveLength(1);
  const row = result.element().parentElement?.textContent ?? "";
  expect(row).toContain("https://other.example.com/");
  expect(row).not.toContain("https://review.example.com/");
});
