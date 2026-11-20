import { EnvironmentId } from "@t3tools/contracts";
import { gerritTerminalGitCommandTemplate } from "@t3tools/client-runtime/state/source-control";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
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
  useAtomCommand: (() => vi.fn()) as never,
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

it("reports clipboard completion only for the clicked connection", async () => {
  await using screen = await render(
    <GerritConnectionSettings environmentId={environmentId} onSaved={() => {}} />,
  );
  let finishCopy!: () => void;
  const pending = new Promise<void>((resolve) => {
    finishCopy = resolve;
  });
  using write = vi.spyOn(navigator.clipboard, "writeText").mockReturnValue(pending);
  const buttons = screen.getByRole("button", { name: "Copy command template", exact: true });

  await buttons.nth(0).click();
  await expect.element(buttons.nth(0)).toBeDisabled();
  await expect.element(buttons.nth(1)).toBeEnabled();
  await expect
    .element(screen.getByRole("status").filter({ hasText: "Copying command template" }))
    .toBeVisible();
  expect(write).toHaveBeenCalledWith(
    gerritTerminalGitCommandTemplate("https://review.example.com/", environmentId),
  );

  await act(() => finishCopy());
  await expect
    .element(screen.getByRole("status").filter({ hasText: "Command template copied" }))
    .toBeVisible();
  await expect.element(buttons.nth(0)).toBeEnabled();
  expect(screen.getByRole("status").all()).toHaveLength(1);
  expect(buttons.nth(0).element().parentElement?.textContent).toContain("Command template copied");
  expect(buttons.nth(1).element().parentElement?.textContent).not.toContain("copied");
});

it("replaces stale success with a selectable fallback on denial and recovers on retry", async () => {
  await using screen = await render(
    <GerritConnectionSettings environmentId={environmentId} onSaved={() => {}} />,
  );
  using write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  using _error = vi.spyOn(console, "error").mockImplementation(() => {});
  const button = screen.getByRole("button", { name: "Copy command template", exact: true }).nth(0);
  await button.click();
  await expect
    .element(screen.getByRole("status").filter({ hasText: "Command template copied" }))
    .toBeVisible();

  write.mockRejectedValue(new DOMException("Clipboard permission denied", "NotAllowedError"));
  await button.click();
  await expect
    .element(screen.getByRole("alert").filter({ hasText: "Could not copy" }))
    .toBeVisible();
  await expect
    .element(screen.getByText("Command template copied.", { exact: true }))
    .not.toBeInTheDocument();
  const fallback = screen.getByRole("textbox", { name: "Command template", exact: true });
  const command = gerritTerminalGitCommandTemplate("https://review.example.com/", environmentId);
  await expect.element(fallback).toHaveValue(command);
  await fallback.click();
  const field = fallback.element() as HTMLTextAreaElement;
  expect(field.value.slice(field.selectionStart, field.selectionEnd)).toBe(command);
  await expect.element(button).toBeEnabled();

  await button.click();
  await expect
    .element(screen.getByRole("alert").filter({ hasText: "Could not copy" }))
    .toBeVisible();
  await expect.element(fallback).toHaveValue(command);
  write.mockResolvedValue(undefined);
  await button.click();
  await expect
    .element(screen.getByRole("status").filter({ hasText: "Command template copied" }))
    .toBeVisible();
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(fallback).not.toBeInTheDocument();
});
