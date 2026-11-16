import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { GerritDelivery } from "./GerritDelivery";

const state = vi.hoisted(() => ({
  writable: true,
  checkout: {} as unknown,
  upload: vi.fn(),
  install: vi.fn(),
  hook: {} as unknown,
  refresh: vi.fn(),
  status: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) => (atom === "scope" ? "session" : state.writable),
}));
vi.mock("react-native", () => ({ View: "div", TextInput: "input", Switch: "input" }));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => createElement("span", null, children),
}));
vi.mock("../../../components/ui/Button", () => ({
  Button: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => createElement("button", { onClick: onPress, disabled }, label),
}));
vi.mock("../../../state/sourceControl", () => ({
  sourceControlEnvironment: {
    gerritSecurityScope: () => "scope",
    gerritDeliveryCheckout: () => "checkout",
    gerritHook: () => "hook",
    gerritInstallHook: { name: "install", permissionAtom: () => "permission" },
  },
}));
vi.mock("../../../state/pull-requests", () => ({
  composerPullRequests: {
    gerritUploadCommit: { permissionAtom: () => "permission", name: "upload" },
    invalidate: { name: "invalidate" },
  },
}));
vi.mock("../../../state/vcs", () => ({ vcsEnvironment: { refreshStatus: { name: "status" } } }));
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: (command: { name: "upload" | "status" | "invalidate" | "install" }) =>
    state[command.name],
}));
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: (query: string | null) => ({
    data: query === "checkout" ? state.checkout : query === "hook" ? state.hook : null,
    error: null,
    isPending: false,
    refresh: state.refresh,
  }),
}));

const environmentId = EnvironmentId.make("environment");
const key = {
  installation: "https://gerrit.example",
  project: "repo",
  branch: "main",
  changeId: `I${"a".repeat(40)}`,
};
async function setup() {
  state.writable = true;
  state.checkout = {
    kind: "ready",
    change: { key, number: 42, revision: { commit: "a".repeat(40), patchSet: 2 } },
    localBranch: "feature",
    head: "b".repeat(40),
    subject: "subject",
    files: [],
  };
  state.hook = { state: "missing", destination: "/repo/.git/hooks/commit-msg", issues: [] };
  state.install.mockReset().mockResolvedValue({ _tag: "Success" });
  state.upload
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { result: { changeNumber: 42, patchSet: 3 } } });
  state.status.mockReset().mockResolvedValue({ _tag: "Success" });
  state.invalidate.mockReset().mockResolvedValue({ _tag: "Success" });
  state.refresh.mockReset();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<GerritDelivery environmentId={environmentId} cwd="/repo" />));
  const button = (label: string) => {
    const found = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === label,
    );
    if (!found) throw new Error(`Missing ${label}`);
    return found;
  };
  return {
    container,
    button,
    click: async (label: string) => {
      await act(async () => button(label).click());
    },
    async [Symbol.asyncDispose]() {
      await act(async () => root.unmount());
    },
  };
}

it("uploads HEAD directly and refreshes status and reviews", async () => {
  await using screen = await setup();
  await screen.click("Upload commit for review");
  expect(screen.container.textContent).toContain("feature");
  await screen.click("Upload");
  expect(state.upload).toHaveBeenCalledWith({
    environmentId,
    input: { cwd: "/repo", upload: { kind: "patch-set", number: 42, commit: "b".repeat(40) } },
  });
  expect(state.status).toHaveBeenCalledWith({ environmentId, input: { cwd: "/repo" } });
  expect(state.invalidate).toHaveBeenCalledOnce();
  expect(screen.container.textContent).toContain("Upload complete · Change #42 · Patch set 3");
});

it("uploads a new change to the configured branch", async () => {
  await using screen = await setup();
  state.checkout = {
    kind: "new-change",
    key,
    localBranch: "feature",
    head: "b".repeat(40),
    subject: "subject",
    files: [],
  };
  await screen.click("Upload commit for review");
  await screen.click("Upload");
  expect(state.upload).toHaveBeenCalledWith({
    environmentId,
    input: { cwd: "/repo", upload: { kind: "new", branch: "main", commit: "b".repeat(40) } },
  });
});

it("shows upload errors without refreshing status", async () => {
  await using screen = await setup();
  state.upload.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new Error("Push rejected")),
  });
  await screen.click("Upload commit for review");
  await screen.click("Upload");
  expect(screen.container.textContent).toContain("Push rejected");
  expect(state.status).not.toHaveBeenCalled();
});

it("blocks the upload entry without command permission", async () => {
  state.writable = false;
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<GerritDelivery environmentId={environmentId} cwd="/repo" />));
  expect(container.querySelector("button")?.disabled).toBe(true);
  await act(async () => root.unmount());
});

it("rereads the checkout when the upload form reopens", async () => {
  await using screen = await setup();
  await screen.click("Upload commit for review");
  await screen.click("Close");
  state.refresh.mockClear();
  await screen.click("Upload commit for review");
  expect(state.refresh).toHaveBeenCalledOnce();
});

it("shows a blocked checkout", async () => {
  await using screen = await setup();
  state.checkout = { kind: "blocked", detail: "Checkout is blocked." };
  await screen.click("Upload commit for review");
  expect(screen.container.textContent).toContain("Checkout is blocked.");
  expect(screen.button("Upload").disabled).toBe(true);
});

it("blocks the current patch set and dirty checkouts", async () => {
  await using screen = await setup();
  state.checkout = { ...(state.checkout as object), head: "a".repeat(40) };
  await screen.click("Upload commit for review");
  expect(screen.button("Upload").disabled).toBe(true);
  expect(screen.container.textContent).toContain("HEAD is already patch set 2");
  await screen.click("Close");
  state.checkout = {
    ...(state.checkout as object),
    head: "b".repeat(40),
    files: [{ path: "one" }],
  };
  await screen.click("Upload commit for review");
  expect(screen.button("Upload").disabled).toBe(true);
  expect(screen.container.textContent).toContain("1 uncommitted file");
  expect(state.upload).not.toHaveBeenCalled();
});

it("diagnoses and installs the missing checkout hook", async () => {
  await using screen = await setup();
  await screen.click("Upload commit for review");
  expect(screen.container.textContent).toContain("missing · /repo/.git/hooks/commit-msg");
  await screen.click("Install hook");
  expect(state.install).toHaveBeenCalledWith({
    environmentId,
    input: { cwd: "/repo" },
  });
  expect(state.refresh).toHaveBeenCalled();
});
