// @vitest-environment happy-dom
/**
 * The DOM context menu, driven through a real (happy-dom) document — the
 * whole point of this module is what it puts in the DOM and how it responds
 * to pointer and key events, so there is nothing left to test if the DOM is
 * faked away. GlobalRegistrator is scoped to this file, the same way
 * useAppTheme.test.tsx scopes it.
 */
import { afterEach, describe, expect, test } from "vitest";
import type { ContextMenuItem } from "@port/shared/types";
import {
  createContextMenuController,
  isContextMenuOpen,
  type ContextMenuController,
} from "./ContextMenu";

let controller: ContextMenuController | null = null;

function makeController(): ContextMenuController {
  controller = createContextMenuController(document);
  return controller;
}

// Registration is process-wide and throws if a second suite registers over
// it, so every file that registers hands it back — the same
// register()/unregister() pairing the app's own DOM suites use.


afterEach(() => {
  controller?.dispose();
  controller = null;
  document.body.innerHTML = "";
});


function menus(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[role="menu"]')) as HTMLElement[];
}

function itemsOf(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll('[role="menuitem"]')) as HTMLElement[];
}

function activeId(): string | null {
  return (document.activeElement as HTMLElement | null)?.getAttribute("data-menu-id") ?? null;
}

function key(name: string): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
}

/** Resolves on the next macrotask — enough for a settled promise to land. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const BASIC: ContextMenuItem[] = [
  { id: "new-terminal", label: "New terminal here" },
  { id: "separator", label: "" },
  { id: "remove", label: "Remove", enabled: false },
  { id: "retry", label: "Retry" },
];

describe("rendering", () => {
  test.each([["darwin", "⌘⇧W"], ["linux", "Ctrl+Shift+W"]])("shows a screen shortcut for %s without changing the action", async (platform, hint) => {
    controller = createContextMenuController(document, platform);
    const result = controller.show([{ id: "close", label: "Close", accelerator: "CommandOrControl+Shift+W" }]);
    const row = itemsOf(menus()[0]!)[0]!;
    expect(row.querySelector("[data-menu-shortcut]")?.textContent).toBe(hint);
    row.click();
    expect(await result).toBe("close");
  });

  test("renders one menuitem per non-separator item, in order", () => {
    void makeController().show(BASIC);
    const menu = menus()[0]!;
    expect(menu.getAttribute("role")).toBe("menu");
    expect(itemsOf(menu).map((el) => el.textContent)).toEqual([
      "New terminal here",
      "Remove",
      "Retry",
    ]);
  });

  test("a `separator` id renders as role=separator, not a menuitem", () => {
    void makeController().show(BASIC);
    const menu = menus()[0]!;
    expect(menu.querySelectorAll('[role="separator"]').length).toBe(1);
  });

  test("enabled: false marks the item aria-disabled", () => {
    void makeController().show(BASIC);
    const [first, disabled] = itemsOf(menus()[0]!);
    expect(disabled!.getAttribute("aria-disabled")).toBe("true");
    expect(first!.getAttribute("aria-disabled")).toBe("false");
  });

  test("opens at the last pointer position", () => {
    const c = makeController();
    document.dispatchEvent(
      new MouseEvent("contextmenu", { clientX: 120, clientY: 64, bubbles: true }),
    );
    void c.show(BASIC);
    const menu = menus()[0]!;
    expect(menu.style.left).toBe("120px");
    expect(menu.style.top).toBe("64px");
  });

  test("a pointerdown position counts too — menus opened from a left click", () => {
    const c = makeController();
    document.dispatchEvent(
      new MouseEvent("pointerdown", { clientX: 8, clientY: 9, bubbles: true }),
    );
    void c.show(BASIC);
    expect(menus()[0]!.style.left).toBe("8px");
  });
});

// desktop.ts's shortcut handler consults this: its own listener is
// capture-phase on `window` and runs BEFORE this module's document-capture
// one, so without the flag a shortcut would fire behind an open menu — which
// a modal native menu never allows.
describe("modality", () => {
  test("no menu open to begin with", () => {
    expect(isContextMenuOpen()).toBe(false);
  });

  test("open while a menu is up, closed again once it resolves", async () => {
    const c = makeController();
    const picked = c.show(BASIC);
    expect(isContextMenuOpen()).toBe(true);
    key("Escape");
    await picked;
    expect(isContextMenuOpen()).toBe(false);
  });

  test("a choice closes it too, and the count never goes negative", async () => {
    const c = makeController();
    const picked = c.show(BASIC);
    itemsOf(menus()[0]!)[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await picked;
    expect(isContextMenuOpen()).toBe(false);
    // dispose() on an already-settled menu must not decrement a second time.
    c.dispose();
    expect(isContextMenuOpen()).toBe(false);
  });

  test("two controllers with one menu each — the first to close does not clear the other", async () => {
    const a = createContextMenuController(document);
    const b = createContextMenuController(document);
    const first = a.show(BASIC);
    const second = b.show(BASIC);
    expect(isContextMenuOpen()).toBe(true);
    a.dispose();
    await first;
    expect(isContextMenuOpen()).toBe(true);
    b.dispose();
    await second;
    expect(isContextMenuOpen()).toBe(false);
  });
});

describe("choosing", () => {
  test("clicking an item resolves its id and tears the menu down", async () => {
    const picked = makeController().show(BASIC);
    itemsOf(menus()[0]!)[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(await picked).toBe("new-terminal");
    expect(menus().length).toBe(0);
  });

  test("clicking a disabled item does nothing", async () => {
    const picked = makeController().show(BASIC);
    itemsOf(menus()[0]!)[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(menus().length).toBe(1);
    key("Escape");
    expect(await picked).toBe(null);
  });

  test("Escape cancels with null", async () => {
    const picked = makeController().show(BASIC);
    key("Escape");
    expect(await picked).toBe(null);
    expect(menus().length).toBe(0);
  });

  test("a backdrop click cancels with null", async () => {
    const picked = makeController().show(BASIC);
    const backdrop = document.querySelector("[data-context-menu-backdrop]") as HTMLElement;
    backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(await picked).toBe(null);
  });

  test("opening a second menu cancels the first with null", async () => {
    const c = makeController();
    const first = c.show(BASIC);
    const second = c.show(BASIC);
    expect(await first).toBe(null);
    expect(menus().length).toBe(1);
    key("Escape");
    expect(await second).toBe(null);
  });

  test("dispose cancels an open menu with null", async () => {
    const c = makeController();
    const picked = c.show(BASIC);
    c.dispose();
    expect(await picked).toBe(null);
    expect(menus().length).toBe(0);
  });

  test("an empty item list still resolves — Escape, not a wedged promise", async () => {
    const picked = makeController().show([]);
    key("Escape");
    expect(await picked).toBe(null);
  });
});

describe("keyboard navigation", () => {
  test("ArrowDown activates the first enabled item, skipping separators and disabled", () => {
    void makeController().show(BASIC);
    key("ArrowDown");
    expect(activeId()).toBe("new-terminal");
    key("ArrowDown");
    expect(activeId()).toBe("retry");
  });

  test("ArrowDown wraps at the end", () => {
    void makeController().show(BASIC);
    key("ArrowDown");
    key("ArrowDown");
    key("ArrowDown");
    expect(activeId()).toBe("new-terminal");
  });

  test("ArrowUp from nothing selected activates the last enabled item", () => {
    void makeController().show(BASIC);
    key("ArrowUp");
    expect(activeId()).toBe("retry");
  });

  test("Enter picks the active item", async () => {
    const picked = makeController().show(BASIC);
    key("ArrowDown");
    key("Enter");
    expect(await picked).toBe("new-terminal");
  });

  test("Enter with nothing active does not resolve", async () => {
    const picked = makeController().show(BASIC);
    key("Enter");
    await flush();
    expect(menus().length).toBe(1);
    key("Escape");
    expect(await picked).toBe(null);
  });
});

const WITH_SUBMENU: ContextMenuItem[] = [
  { id: "new-terminal", label: "New terminal here" },
  {
    id: "new-agent",
    label: "New agent",
    submenu: [
      { id: "new-agent-claude", label: "Claude Code" },
      { id: "new-agent-codex", label: "Codex" },
    ],
  },
  { id: "separator", label: "" },
  { id: "remove", label: "Remove" },
];

describe("submenus", () => {
  test("a parent item is marked aria-haspopup", () => {
    void makeController().show(WITH_SUBMENU);
    expect(itemsOf(menus()[0]!)[1]!.getAttribute("aria-haspopup")).toBe("true");
  });

  test("ArrowRight on the parent opens the child menu", () => {
    void makeController().show(WITH_SUBMENU);
    key("ArrowDown");
    key("ArrowDown");
    key("ArrowRight");
    expect(menus().length).toBe(2);
    expect(itemsOf(menus()[1]!).map((el) => el.textContent)).toEqual(["Claude Code", "Codex"]);
    expect(activeId()).toBe("new-agent-claude");
  });

  test("ArrowLeft closes the child and returns to the parent", () => {
    void makeController().show(WITH_SUBMENU);
    key("ArrowDown");
    key("ArrowDown");
    key("ArrowRight");
    key("ArrowLeft");
    expect(menus().length).toBe(1);
    expect(activeId()).toBe("new-agent");
  });

  test("clicking the parent opens the child rather than resolving the parent's id", async () => {
    const picked = makeController().show(WITH_SUBMENU);
    itemsOf(menus()[0]!)[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(menus().length).toBe(2);
    itemsOf(menus()[1]!)[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(await picked).toBe("new-agent-codex");
  });

  test("Escape inside a child menu closes only the child", async () => {
    const picked = makeController().show(WITH_SUBMENU);
    key("ArrowDown");
    key("ArrowDown");
    key("ArrowRight");
    key("Escape");
    expect(menus().length).toBe(1);
    key("Escape");
    expect(await picked).toBe(null);
  });
});
