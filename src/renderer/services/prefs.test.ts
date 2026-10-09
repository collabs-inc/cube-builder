import { describe, expect, test } from "vitest";
import { createPrefsApi } from "./prefs";

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: (index) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

describe("createPrefsApi", () => {
  test("getPref returns null when nothing is stored", async () => {
    const api = createPrefsApi({ storage: fakeStorage() });
    expect(await api.getPref("theme")).toBeNull();
  });

  test("setPref / getPref round-trip a JSON value under pref:<key>", async () => {
    const storage = fakeStorage();
    const api = createPrefsApi({ storage });
    await api.setPref("theme", { mode: "dark" });
    expect(await api.getPref("theme")).toEqual({ mode: "dark" });
    expect(storage.getItem("pref:theme")).toBe(JSON.stringify({ mode: "dark" }));
  });

  test("getWorkspacePref returns null when nothing is stored", async () => {
    const api = createPrefsApi({ storage: fakeStorage() });
    expect(await api.getWorkspacePref("sort", "/repo")).toBeNull();
  });

  test("setWorkspacePref / getWorkspacePref round-trip under wpref:<path>:<key>", async () => {
    const storage = fakeStorage();
    const api = createPrefsApi({ storage });
    await api.setWorkspacePref("sort", "name", "/repo");
    expect(await api.getWorkspacePref("sort", "/repo")).toBe("name");
    expect(storage.getItem("wpref:/repo:sort")).toBe(JSON.stringify("name"));
  });

  test("workspace prefs are isolated per workspacePath", async () => {
    const storage = fakeStorage();
    const api = createPrefsApi({ storage });
    await api.setWorkspacePref("sort", "name", "/repo-a");
    await api.setWorkspacePref("sort", "date", "/repo-b");
    expect(await api.getWorkspacePref("sort", "/repo-a")).toBe("name");
    expect(await api.getWorkspacePref("sort", "/repo-b")).toBe("date");
  });

  test("getConfig returns the greenfield default shape", async () => {
    const api = createPrefsApi({ storage: fakeStorage() });
    expect(await api.getConfig()).toEqual({ window_state: null, ui: {} });
  });

  test("getDeviceId mints a uuid once and persists it under device_id", async () => {
    const storage = fakeStorage();
    const api = createPrefsApi({ storage });
    const first = await api.getDeviceId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(storage.getItem("device_id")).toBe(first);
    const second = await api.getDeviceId();
    expect(second).toBe(first);
  });

  test("a corrupt pref value falls back to null rather than throwing", async () => {
    const storage = fakeStorage();
    storage.setItem("pref:theme", "{not json");
    const api = createPrefsApi({ storage });
    expect(await api.getPref("theme")).toBeNull();
  });

  test("getAppVersion resolves the standalone package version", async () => {
    const { default: packageInfo } = await import('../../../package.json');
    expect(await createPrefsApi({storage:fakeStorage()}).getAppVersion()).toBe(packageInfo.version);
  });

  // Safari private browsing (and similar storage-blocked contexts) throws
  // synchronously on setItem — a pref write must not turn that into a
  // rejected promise.
  test("setPref swallows a blocked setItem instead of rejecting", async () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    } as unknown as Storage;
    const api = createPrefsApi({ storage });
    await expect(api.setPref("theme", "dark")).resolves.toBeUndefined();
  });

  test("setWorkspacePref swallows a blocked setItem instead of rejecting", async () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    } as unknown as Storage;
    const api = createPrefsApi({ storage });
    await expect(api.setWorkspacePref("sort", "name", "/repo")).resolves.toBeUndefined();
  });

  test("getDeviceId still resolves a minted id even when persisting it fails", async () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    } as unknown as Storage;
    const api = createPrefsApi({ storage });
    const id = await api.getDeviceId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
