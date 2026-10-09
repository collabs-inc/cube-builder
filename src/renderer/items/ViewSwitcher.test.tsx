// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot } from "react-dom/client";
import { ViewSwitcher } from "./ViewSwitcher";
import { takeInstantScreenNavigation } from "../state/screen-navigation";
import { closeScreen, hydrate, renameScreen, workspaceStore } from "../state/workspace";
import { setServices } from "../services";
import type { Services } from "../services/types";

function createFakeServices(): Services {
  const desktop: Pick<Services["desktop"], "getPlatform" | "showContextMenu"> = {
    getPlatform: () => "linux",
    showContextMenu: async () => null,
  };
  return { desktop } as Services;
}
import { useTooltips } from "../hooks/useTooltips";

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  takeInstantScreenNavigation();
  setServices(createFakeServices());
  hydrate({
    activeItemId: "b",
    activeView: "screen:build",
    screens: [
      {
        id: "research",
        name: "Research",
        columns: [{ id: "research-column", widthRatio: 1, panes: [{ itemId: "a", heightRatio: 1 }] }],
      },
      {
        id: "build",
        name: "Build",
        columns: [{ id: "build-column", widthRatio: 1, panes: [{ itemId: "b", heightRatio: 1 }] }],
      },
      { id: "empty", name: "Screen 3", columns: [] },
    ],
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<ViewSwitcher />));
});

afterEach(() => {
  takeInstantScreenNavigation();
  act(() => root?.unmount());
  root = undefined;
  container.remove();
});


test("clicking a screen tab requests an immediate jump to its screen", () => {
  act(() => container.querySelector<HTMLElement>('[data-screen-id="research"]')!.click());
  expect(workspaceStore.getSnapshot().activeView).toBe("screen:research");
  expect(takeInstantScreenNavigation()).toBe("research");
});

test("hovering a screen displays only its selection shortcut through the app tooltip", () => {
  const fake = createFakeServices();
  fake.desktop.getPlatform = () => "darwin";
  setServices(fake);
  function Fixture() { useTooltips(); return <ViewSwitcher />; }
  act(() => root!.render(<Fixture />));
  const tab = container.querySelector<HTMLElement>('[data-screen-id="build"]')!;
  act(() => tab.dispatchEvent(new MouseEvent("mouseenter")));
  expect(document.querySelector(".app-tooltip")?.textContent).toBe("⌘2");
  expect(tab.hasAttribute("title")).toBe(false);
  expect(tab.getAttribute("aria-label")).toBe("Build");
});

test("the strip renders every global screen by its screen name and exposes drag hit targets", () => {
  expect(container.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe("Screens");
  const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
  expect(tabs.map(tab => tab.getAttribute("aria-label"))).toEqual(["Research", "Build", "Screen 3"]);
  expect(tabs.map(tab => tab.dataset.screenId)).toEqual(["research", "build", "empty"]);
  expect(container.querySelector(".view-switcher-repo")).toBeNull();
  expect(container.querySelector('[data-screen-id="empty"]')!.textContent).toBe("");
  expect(container.querySelector(".view-switcher-close")).toBeNull();
});

test("right-click names an untitled screen, Escape cancels, and clearing removes its title", async () => {
  const fakes = createFakeServices();
  fakes.desktop.showContextMenu = async () => "rename";
  setServices(fakes);
  // Re-queried at every read: naming changes whether the screen is the
  // spare, which swaps its indicator component and so its DOM node.
  const tab = () => container.querySelector<HTMLElement>('[data-screen-id="empty"]')!;
  const edit = async () => {
    await act(async () => { tab().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    return container.querySelector<HTMLInputElement>('[aria-label="Screen name"]')!;
  };
  let input = await edit();
  expect(input).not.toBeNull();
  expect(workspaceStore.getSnapshot().activeView).toBe("screen:build");
  input.value = "  Review  ";
  act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(tab().textContent).toBe("Review");
  input = await edit();
  input.value = "Discard";
  act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(tab().textContent).toBe("Review");
  input = await edit();
  input.value = "";
  act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(tab().textContent).toBe("");
  expect(tab().getAttribute("aria-label")).toBe("Screen 3");
});

test("naming marks the indicator while it edits and leaves a fresh spare behind it", async () => {
  const fakes = createFakeServices();
  fakes.desktop.showContextMenu = async () => "rename";
  setServices(fakes);
  const tab = () => container.querySelector<HTMLElement>('[data-screen-id="empty"]')!;
  await act(async () => { tab().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
  // The naming marker carries the width rule: a blank field keeps the
  // compact indicator width instead of the wide unnamed-tab exception.
  expect(tab().dataset.screenNaming).toBe("true");
  expect(tab().dataset.screenUnnamed).toBeUndefined();
  const input = container.querySelector<HTMLInputElement>('[aria-label="Screen name"]')!;
  input.value = "Review";
  act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(tab().dataset.screenNaming).toBeUndefined();
  expect([...container.querySelectorAll<HTMLElement>('[role="tab"]')].map(t => t.textContent))
    .toEqual(["Research", "Build", "Review", ""]);
});

test("unnamed screens show their column and stack proportions without content", () => {
  act(() => hydrate({
    activeItemId: "a",
    activeView: "screen:layout",
    screens: [{ id: "layout", name: "", columns: [
      { id: "left", widthRatio: 0.6, panes: [{ itemId: "a", heightRatio: 1 }] },
      { id: "right", widthRatio: 0.4, panes: [{ itemId: "b", heightRatio: 0.25 }, { itemId: "c", heightRatio: 0.75 }] },
    ] }, { id: "spare", name: "", columns: [] }],
  }));
  const tab = container.querySelector<HTMLElement>('[data-screen-id="layout"]')!;
  const preview = tab.querySelector<HTMLElement>(".view-switcher-layout")!;
  expect(tab.dataset.screenUnnamed).toBe("true");
  expect(preview.getAttribute("aria-hidden")).toBe("true");
  expect(preview.style.gridTemplateColumns).toBe("0.6fr 0.4fr");
  const columns = [...preview.querySelectorAll<HTMLElement>(".view-switcher-layout-column")];
  expect(columns.map(column => column.style.gridTemplateRows)).toEqual(["1fr", "0.25fr 0.75fr"]);
  expect(preview.querySelectorAll(".view-switcher-layout-tile")).toHaveLength(3);
  expect(tab.textContent).toBe("");
  expect(container.querySelectorAll('[data-screen-id="spare"] .view-switcher-layout')).toHaveLength(0);
});

test("keyboard selection follows global strip order and Delete closes the selected screen", () => {
  const build = container.querySelector<HTMLElement>('[data-screen-id="build"]')!;
  act(() => build.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
  expect(workspaceStore.getSnapshot().activeView).toBe("screen:research");

  const research = container.querySelector<HTMLElement>('[data-screen-id="research"]')!;
  act(() => research.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })));
  expect(workspaceStore.getSnapshot().screens.map(screen => screen.id)).toEqual(["build", "empty"]);
  expect(container.querySelector('[data-screen-id="research"]')).toBeNull();
});

test("the overflow fade clears when the last exiting indicator is removed", () => {
  const strip = container.querySelector<HTMLElement>(".view-switcher-scroll")!;
  Object.defineProperty(strip, "clientWidth", { configurable: true, value: 100 });
  Object.defineProperty(strip, "scrollWidth", { configurable: true, get: () => strip.querySelectorAll(".view-switcher-option").length * 50 });
  act(() => closeScreen("research"));
  act(() => strip.dispatchEvent(new Event("scroll")));
  expect(strip.style.getPropertyValue("--fade-r")).toBe("16px");
  const exiting = strip.querySelector<HTMLElement>("[data-screen-exiting]")!;
  act(() => exiting.dispatchEvent(new Event("animationend", { bubbles: true })));
  expect(strip.style.getPropertyValue("--fade-r")).toBe("0px");
});

test("closed screens leave inert indicators until their exit animations finish", () => {
  expect(container.querySelector(".view-switcher")?.getAttribute("data-multiple-screens")).toBe("true");
  act(() => closeScreen("research"));
  expect(workspaceStore.getSnapshot().screens.some(screen => screen.id === "research")).toBe(false);
  const exiting = container.querySelector<HTMLElement>('[data-screen-exiting="research"]')!;
  expect(exiting.getAttribute("aria-hidden")).toBe("true");
  expect(exiting.hasAttribute("inert")).toBe(true);
  expect(exiting.hasAttribute("role")).toBe(false);
  expect(exiting.hasAttribute("data-screen-id")).toBe(false);
  act(() => closeScreen("build"));
  expect(container.querySelector(".view-switcher")?.getAttribute("data-multiple-screens")).toBe("false");
  expect(container.querySelectorAll("[data-screen-exiting]")).toHaveLength(2);
  expect([...container.querySelectorAll<HTMLElement>(".view-switcher-option")].map(el => el.dataset.screenId ?? el.dataset.screenExiting))
    .toEqual(["research", "build", "empty"]);
  act(() => exiting.dispatchEvent(new Event("animationend", { bubbles: true })));
  expect(container.querySelectorAll('[data-screen-exiting="research"]')).toHaveLength(0);
  expect(container.querySelectorAll('[data-screen-exiting="build"]')).toHaveLength(1);
});

test("keyboard focus stays on the chosen screen when the empty source closes after its delay", async () => {
  act(() => hydrate({
    activeItemId: null,
    activeView: "screen:departed",
    screens: [
      { id: "departed", name: "", columns: [] },
      { id: "destination", name: "Destination", columns: [{ id: "column", widthRatio: 1, panes: [{ itemId: "a", heightRatio: 1 }] }] },
      { id: "empty", name: "Screen 3", columns: [] },
    ],
  }));
  const departed = container.querySelector<HTMLElement>('[data-screen-id="departed"]')!;
  departed.focus();
  act(() => departed.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));

  expect(workspaceStore.getSnapshot().activeView).toBe("screen:destination");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 550)); });
  expect(workspaceStore.getSnapshot().screens.map(screen => screen.id)).toEqual(["destination", "empty"]);
  expect((document.activeElement as HTMLElement).dataset.screenId).toBe("destination");
});

test("the indicator menu moves screens left and right, never past the spare", async () => {
  const fakes = createFakeServices();
  let offered: { id: string; enabled?: boolean }[] = [];
  let pick: string | null = null;
  fakes.desktop.showContextMenu = async (items) => { offered = items; return pick; };
  setServices(fakes);
  const tab = (id: string) => container.querySelector<HTMLElement>(`[data-screen-id="${id}"]`)!;
  const menu = async (id: string, choice: string | null) => {
    pick = choice;
    await act(async () => { tab(id).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
  };
  const order = () => workspaceStore.getSnapshot().screens.map((screen) => screen.id);

  await menu("research", null);
  expect(offered.find((item) => item.id === "move-left")?.enabled).toBe(false);
  expect(offered.find((item) => item.id === "move-right")?.enabled).not.toBe(false);

  await menu("research", "move-right");
  expect(order()).toEqual(["build", "research", "empty"]);

  await menu("research", null);
  expect(offered.find((item) => item.id === "move-right")?.enabled).toBe(false);

  await menu("empty", null);
  expect(offered.some((item) => item.id === "move-left" || item.id === "move-right")).toBe(false);
});

test("live indicators are sortable, the spare is not, and all keep their tab semantics", () => {
  const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
  expect(tabs.map((tab) => tab.dataset.screenId)).toEqual(["research", "build", "empty"]);
  expect(tabs.filter((tab) => tab.getAttribute("aria-roledescription") === "sortable").map((tab) => tab.dataset.screenId))
    .toEqual(["research", "build"]);
  expect(tabs.filter((tab) => tab.tabIndex === 0)).toHaveLength(1);
});

test("naming the spare makes it sortable, and the new spare is not", () => {
  const original = container.querySelector('[data-screen-id="empty"]');
  act(() => renameScreen("empty", "Review"));
  expect(container.querySelector('[data-screen-id="empty"]') === original).toBe(true);
  const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
  expect(tabs).toHaveLength(4);
  expect(tabs.filter((tab) => tab.getAttribute("aria-roledescription") === "sortable").map((tab) => tab.dataset.screenId))
    .toEqual(["research", "build", "empty"]);
  expect(tabs[3]!.getAttribute("aria-roledescription")).not.toBe("sortable");
});

test("closing preserves the indicator DOM so its outline can transition", () => {
  const original = container.querySelector('[data-screen-id="research"]');
  act(() => closeScreen("research"));
  expect(container.querySelector('[data-screen-exiting="research"]') === original).toBe(true);
});
