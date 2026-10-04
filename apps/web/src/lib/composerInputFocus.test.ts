import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { pasteTextToFocusComposer, shouldTypeToFocusComposer } from "./composerInputFocus";

class FakeElement extends EventTarget {
  constructor(
    private readonly selector: string,
    private readonly parent?: FakeElement,
  ) {
    super();
  }

  closest(selectors: string): FakeElement | null {
    return selectors.split(",").includes(this.selector)
      ? this
      : (this.parent?.closest(selectors) ?? null);
  }
}

function keyEvent(target: FakeElement, key = "a") {
  return Object.assign(new Event("keydown", { cancelable: true }), {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    isComposing: false,
    composedPath: () => [target],
  }) as unknown as KeyboardEvent;
}

function pasteEvent(target: FakeElement, text = "hello") {
  return Object.assign(new Event("paste", { cancelable: true }), {
    clipboardData: { files: [], getData: () => text },
    composedPath: () => [target],
  }) as unknown as ClipboardEvent;
}

beforeEach(() => {
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("document", { querySelector: () => null });
});
afterEach(() => vi.unstubAllGlobals());

describe("composer input focus", () => {
  it("redirects typing and plain-text paste from empty space to the composer", () => {
    const body = new FakeElement("body");
    expect(shouldTypeToFocusComposer(keyEvent(body))).toBe(true);
    expect(pasteTextToFocusComposer(pasteEvent(body))).toBe("hello");
  });

  it("leaves typing and paste on the focused device screen", () => {
    const screen = new FakeElement('[role="application"]');
    expect(shouldTypeToFocusComposer(keyEvent(screen))).toBe(false);
    expect(pasteTextToFocusComposer(pasteEvent(screen))).toBeNull();
  });

  it("leaves input from device screen descendants on the device", () => {
    const canvas = new FakeElement("canvas", new FakeElement('[role="application"]'));
    expect(shouldTypeToFocusComposer(keyEvent(canvas))).toBe(false);
    expect(pasteTextToFocusComposer(pasteEvent(canvas))).toBeNull();
  });

  it.each(["input", "textarea", "button", '[role="textbox"]'])(
    "leaves input in %s alone",
    (selector) => {
      const target = new FakeElement(selector);
      expect(shouldTypeToFocusComposer(keyEvent(target))).toBe(false);
      expect(pasteTextToFocusComposer(pasteEvent(target))).toBeNull();
    },
  );

  it("does not redirect handled keys, shortcuts, or composition", () => {
    const target = new FakeElement("body");
    const handled = keyEvent(target);
    handled.preventDefault();
    expect(shouldTypeToFocusComposer(handled)).toBe(false);
    expect(shouldTypeToFocusComposer(keyEvent(target, "Enter"))).toBe(false);
    expect(shouldTypeToFocusComposer(Object.assign(keyEvent(target), { ctrlKey: true }))).toBe(
      false,
    );
    expect(shouldTypeToFocusComposer(Object.assign(keyEvent(target), { isComposing: true }))).toBe(
      false,
    );
  });

  it("keeps input out of the composer while a floating layer is open", () => {
    vi.stubGlobal("document", { querySelector: () => new FakeElement('[role="dialog"]') });
    const target = new FakeElement("body");
    expect(shouldTypeToFocusComposer(keyEvent(target))).toBe(false);
    expect(pasteTextToFocusComposer(pasteEvent(target))).toBeNull();
  });
});
