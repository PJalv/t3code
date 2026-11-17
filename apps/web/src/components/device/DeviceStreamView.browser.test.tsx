import { useEffect, useSyncExternalStore } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, onTestFinished, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";

const accessStore = {
  value: { httpBase: "http://test", wsBase: "ws://test", query: {}, credentials: true },
  listeners: new Set<() => void>(),
  refresh() {
    accessStore.value = { ...accessStore.value };
    for (const listener of accessStore.listeners) listener();
  },
  subscribe(listener: () => void) {
    accessStore.listeners.add(listener);
    return () => accessStore.listeners.delete(listener);
  },
};
vi.mock(import("~/state/device"), async (original) => ({
  ...(await original()),
  useDeviceHubAccess: () => useSyncExternalStore(accessStore.subscribe, () => accessStore.value),
  refreshDeviceHubAccess: () => accessStore.refresh(),
}));
// Counts of access primes and viewer mounts, reset by each setup().
let primes = 0;
let viewerMounts = 0;
let viewerUnmounts = 0;
// The 3D phone frame needs WebGL; the test only cares whether it stays mounted.
vi.mock(import("./DevicePhoneViewport"), async (original) => ({
  ...(await original()),
  DevicePhoneViewport: function Viewer(): React.ReactElement {
    useEffect(() => {
      viewerMounts++;
      return () => {
        viewerUnmounts++;
      };
    }, []);
    return <></>;
  },
}));
import { DeviceStreamView, type DeviceViewControls } from "./DeviceStreamView";

// MJPEG frames come from the device hub, so images keep their src without loading it and a
// test publishes a frame by setting the natural size and firing "load".
const imageSources = new WeakMap<HTMLImageElement, string>();
const framedImages = new WeakSet<HTMLImageElement>();
let images: HTMLImageElement[] = [];
const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!;
const naturalWidthDescriptor = Object.getOwnPropertyDescriptor(
  HTMLImageElement.prototype,
  "naturalWidth",
)!;
const naturalHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLImageElement.prototype,
  "naturalHeight",
)!;
const removeAttribute = Element.prototype.removeAttribute;
function stubImages() {
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    configurable: true,
    get(this: HTMLImageElement) {
      return imageSources.get(this) ?? "";
    },
    set(this: HTMLImageElement, value: string) {
      if (!images.includes(this)) images.push(this);
      imageSources.set(this, value);
    },
  });
  for (const name of ["naturalWidth", "naturalHeight"]) {
    Object.defineProperty(HTMLImageElement.prototype, name, {
      configurable: true,
      get(this: HTMLImageElement) {
        if (!framedImages.has(this)) return 0;
        return name === "naturalWidth" ? 400 : 800;
      },
    });
  }
  Element.prototype.removeAttribute = function (this: Element, name: string) {
    if (this instanceof HTMLImageElement && name === "src") imageSources.delete(this);
    return removeAttribute.call(this, name);
  };
}
function restoreImages() {
  Object.defineProperty(HTMLImageElement.prototype, "src", srcDescriptor);
  Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", naturalWidthDescriptor);
  Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", naturalHeightDescriptor);
  Element.prototype.removeAttribute = removeAttribute;
}
async function publishFrame(image: HTMLImageElement) {
  framedImages.add(image);
  await act(async () => image.dispatchEvent(new Event("load")));
}
// Each test renders through the shared helper so the React root and the DOM
// stubs are disposed together; only the image stubs need restoring by hand.
let messages: Array<string | Uint8Array> = [];
let touches: unknown[] = [];

function sizedContainer() {
  const element = document.createElement("div");
  element.style.cssText = "width: 400px; height: 800px; display: flex";
  return element;
}

// Tests own the screen with `await using`, so the root unmounts even on failure.
function renderView(view: (visible: boolean) => React.ReactElement) {
  container = sizedContainer();
  return render(view(true), { container });
}

async function setup(platform: "ios" | "android" = "ios", h264 = false, withControls = false) {
  onTestFinished(() => {
    vi.unstubAllGlobals();
    restoreImages();
  });
  primes = 0;
  viewerMounts = 0;
  viewerUnmounts = 0;
  images = [];
  messages = [];
  touches = [];
  stubImages();
  let videoBody: ReadableStreamDefaultController<Uint8Array> | undefined;
  let output: VideoFrameOutputCallback | undefined;
  if (h264) {
    vi.stubGlobal(
      "VideoDecoder",
      class {
        static isConfigSupported = async () => ({ supported: true });
        state = "unconfigured";
        constructor(callbacks: VideoDecoderInit) {
          output = callbacks.output;
        }
        configure() {
          this.state = "configured";
        }
        close() {
          this.state = "closed";
        }
      },
    );
    vi.stubGlobal("EncodedVideoChunk", vi.fn());
  } else {
    // Without WebCodecs the iOS client streams MJPEG.
    const videoDecoder = Object.getOwnPropertyDescriptor(globalThis, "VideoDecoder");
    if (videoDecoder) {
      Reflect.deleteProperty(globalThis, "VideoDecoder");
      onTestFinished(() => {
        Object.defineProperty(globalThis, "VideoDecoder", videoDecoder);
      });
    }
  }
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    if (url.endsWith("stream.avcc")) {
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              videoBody = controller;
              init.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
            },
          }),
        ),
      );
    }
    primes++;
    return Promise.resolve(new Response("prime"));
  });
  const sockets: Array<{ onmessage?: (event: { data: ArrayBuffer }) => void }> = [];
  vi.stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      readyState = 1;
      constructor() {
        sockets.push(this);
        openInput(this);
      }
      onmessage?: (event: { data: ArrayBuffer }) => void;
      send(message: string | Uint8Array) {
        messages.push(message);
        // Input frames are 0x03-prefixed JSON; the flat-pointer suite reads those.
        if (typeof message !== "string" && message[0] === 0x03) {
          touches.push(JSON.parse(new TextDecoder().decode(message.subarray(1))));
        }
      }
      close() {}
    },
  );
  // The client opens its input socket only after the MJPEG prime resolves, so the
  // flat-pointer suite waits for the first socket instead of indexing synchronously.
  let openInput!: (socket: { onmessage?: (event: { data: ArrayBuffer }) => void }) => void;
  const inputOpened = new Promise<{ onmessage?: (event: { data: ArrayBuffer }) => void }>(
    (resolve) => {
      openInput = resolve;
    },
  );
  const view = (visible: boolean) => (
    <DeviceStreamView
      hostId="local"
      environmentId={EnvironmentId.make("test")}
      deviceId="test"
      platform={platform}
      visible={visible}
      allowPhoneView={h264}
      // Only the flat-pointer suite reads input-connection state, so the personal
      // tests keep rendering exactly the tree they always did.
      {...(withControls
        ? {
            renderControls: (controls: DeviceViewControls) => (
              <output>
                {controls.handle?.inputConnected ? "Input connected" : "Input disconnected"}
              </output>
            ),
          }
        : {})}
    />
  );
  container = sizedContainer();
  return {
    images,
    view,
    messages,
    touches,
    // `using input = await setup()` needs a disposer; globals and image stubs are
    // also unwound by the onTestFinished hook, which keeps the personal suite working.
    [Symbol.dispose]() {},
    configure() {
      const json = new TextEncoder().encode(
        JSON.stringify({ width: 400, height: 800, orientation: "portrait" }),
      );
      const packet = new Uint8Array(1 + json.length);
      packet[0] = 0x82;
      packet.set(json, 1);
      sockets[0]?.onmessage?.({ data: Uint8Array.of(0x83).buffer });
      sockets[0]?.onmessage?.({ data: packet.buffer });
      videoBody?.enqueue(new Uint8Array([0, 0, 0, 5, 1, 1, 0x64, 0, 0x1f]));
    },
    // The flat-pointer suite drives the input socket once the client opened it.
    async configureInput(inputUnavailable = false) {
      const json = new TextEncoder().encode(
        JSON.stringify({ width: 400, height: 800, orientation: "portrait", inputUnavailable }),
      );
      const packet = new Uint8Array(1 + json.length);
      packet[0] = 0x82;
      packet.set(json, 1);
      const input = await inputOpened;
      input.onmessage?.({ data: Uint8Array.of(0x83).buffer });
      input.onmessage?.({ data: packet.buffer });
    },
    frame() {
      const source = new OffscreenCanvas(400, 800);
      source.getContext("2d")!.fillRect(0, 0, 400, 800);
      output?.(new VideoFrame(source, { timestamp: 0 }));
    },
  };
}

let container: HTMLElement;
const alert = () => container.querySelector('[role="alert"]');
const reconnect = () =>
  act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Reconnect"))!
      .click(),
  );

function flatPointer(container: HTMLElement) {
  const surface = container.querySelector("canvas")!.parentElement!.parentElement!;
  // Synthetic IDs exercise concurrent touches independently of the browser's capture state.
  surface.setPointerCapture = () => {};
  const rect = new DOMRect(0, 0, 400, 800);
  surface.getBoundingClientRect = () => rect;
  return {
    send(type: string, pointerId: number, x = 0.25, y = 0.25) {
      surface.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId,
          pointerType: "touch",
          clientX: rect.left + rect.width * x,
          clientY: rect.top + rect.height * y,
        }),
      );
    },
  };
}

it("keeps the first flat pointer active when a second finger moves and lifts", async () => {
  using input = await setup("ios", false, true);
  const { configureInput, touches, view } = input;
  await using screen = await renderView(view);
  await act(async () => configureInput());
  await expect.element(screen.getByText("Input connected", { exact: true })).toBeVisible();
  const { send } = flatPointer(screen.container);
  send("pointerdown", 1);
  send("pointerdown", 2, 0.75, 0.75);
  send("pointermove", 2, 0.875, 0.875);
  send("pointerup", 2);
  send("pointercancel", 2);
  send("pointermove", 1, 0.5, 0.5);
  send("pointerup", 1, 0.75, 0.75);
  send("pointermove", 1);
  expect(touches).toEqual([
    { type: "begin", x: 0.25, y: 0.25 },
    { type: "move", x: 0.5, y: 0.5 },
    { type: "end", x: 0.75, y: 0.75 },
  ]);
});

it("ignores a flat pointer that goes down before input connects", async () => {
  using input = await setup("ios", false, true);
  const { configureInput, touches, view } = input;
  await using screen = await renderView(view);
  const { send } = flatPointer(screen.container);
  send("pointerdown", 1);
  await act(async () => configureInput());
  await expect.element(screen.getByText("Input connected", { exact: true })).toBeVisible();
  send("pointerdown", 2, 0.5, 0.5);
  send("pointerup", 2, 0.75, 0.75);
  expect(touches).toEqual([
    { type: "begin", x: 0.5, y: 0.5 },
    { type: "end", x: 0.75, y: 0.75 },
  ]);
});

it.each(["pointerup", "pointercancel", "lostpointercapture"])(
  "ends the owned flat pointer exactly once on %s, then accepts a new pointer",
  async (ending) => {
    using input = await setup("ios", false, true);
    const { configureInput, touches, view } = input;
    await using screen = await renderView(view);
    await act(async () => configureInput());
    await expect.element(screen.getByText("Input connected", { exact: true })).toBeVisible();
    const { send } = flatPointer(screen.container);
    send("pointerdown", 7);
    send("pointermove", 7, 0.5, 0.5);
    send("lostpointercapture", 8, 0, 0);
    // Capture loss reports its own point; the end must still use the last move.
    const at = ending === "lostpointercapture" ? 0 : 0.5;
    send(ending, 7, at, at);
    send("lostpointercapture", 7, 0, 0);
    send("pointerup", 7);
    send("pointermove", 7);
    send("pointerdown", 9);
    send("pointerup", 9);
    expect(touches).toEqual([
      { type: "begin", x: 0.25, y: 0.25 },
      { type: "move", x: 0.5, y: 0.5 },
      { type: "end", x: 0.5, y: 0.5 },
      { type: "begin", x: 0.25, y: 0.25 },
      { type: "end", x: 0.25, y: 0.25 },
    ]);
  },
);

it("releases flat pointer ownership when input disconnects", async () => {
  using input = await setup("ios", false, true);
  const { view } = input;
  await using screen = await renderView(view);
  await act(() => input.configureInput());
  await expect.element(screen.getByText("Input connected", { exact: true })).toBeVisible();
  const { send } = flatPointer(screen.container);
  send("pointerdown", 1);
  await act(() => input.configureInput(true));
  await expect.element(screen.getByText("Input disconnected", { exact: true })).toBeVisible();
  await act(() => input.configureInput());
  await expect.element(screen.getByText("Input connected", { exact: true })).toBeVisible();
  send("pointerdown", 2, 0.5, 0.5);
  send("pointerup", 2, 0.75, 0.75);
  expect(input.touches).toEqual([
    { type: "begin", x: 0.25, y: 0.25 },
    { type: "begin", x: 0.5, y: 0.5 },
    { type: "end", x: 0.75, y: 0.75 },
  ]);
});

it("removes MJPEG requests while hidden and reconnects when shown", async () => {
  using _timers = fakeTimers();
  const { images, view } = await setup();
  await using _screen = await renderView(view);
  expect(images[0]!.src).toContain("stream.mjpeg");
  await _screen.rerender(view(false));
  expect(container.querySelectorAll("img")).toHaveLength(0);
  expect(images[0]!.src).toBe("");
  expect(vi.getTimerCount()).toBe(0);
  await _screen.rerender(view(true));
  expect(images.at(-1)!.src).toContain("stream.mjpeg");
});

it("offers Reconnect after the shared timeout and receives a frame after retry with unchanged access", async () => {
  using _timers = fakeTimers();
  const { images, view } = await setup();
  await using _screen = await renderView(view);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(alert()?.textContent).toContain("No video");
  expect(images[0]!.src).toBe("");
  await reconnect();
  expect(alert()).toBeNull();
  expect(images[1]!.src).toContain("stream.mjpeg");
  await publishFrame(images[1]!);
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(container.querySelectorAll("button")).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("sends Ctrl shortcuts to Android and lets a browser paste insert clipboard text once", async () => {
  using _timers = fakeTimers();
  const { messages, view } = await setup("android");
  await using _screen = await renderView(view);
  const application = container.querySelector('[role="application"]')!;
  const key = (value: string) => {
    const event = new KeyboardEvent("keydown", {
      key: value,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    application.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(key("a")).toBe(true);
  expect(key("c")).toBe(true);
  expect(key("v")).toBe(false);
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", "Pasted from the computer");
  application.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
  );
  expect(messages.map((message) => JSON.parse(message as string) as unknown)).toEqual([
    { type: "key", keycode: 29, metaState: 0x1000 },
    { type: "key", keycode: 31, metaState: 0x1000 },
    { type: "text", text: "Pasted from the computer" },
  ]);
});

it("starts exactly one new stream per Reconnect press", async () => {
  using _timers = fakeTimers();
  const { view } = await setup();
  await using _screen = await renderView(view);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(primes).toBe(1);
  await reconnect();
  expect(primes).toBe(2);
});

it("keeps the 3D viewer mounted across iOS video recovery and releases it when hidden", async () => {
  using _timers = fakeTimers();
  const { configure, frame, view } = await setup("ios", true);
  await using _screen = await renderView(view);
  await act(async () => configure());
  expect(viewerMounts).toBe(0);
  await act(async () => frame());
  expect(viewerMounts).toBe(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(viewerUnmounts).toBe(0);
  expect(viewerMounts).toBe(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
    configure();
  });
  await act(async () => frame());
  expect(viewerMounts).toBe(1);
  await _screen.rerender(view(false));
  expect(viewerUnmounts).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});
