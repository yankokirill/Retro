// T-014 § 2 — REQ-002 кр. 1, 3, 4: гостевая личность в localStorage.

import { describe, expect, it } from "vitest";
import { loadGuestIdentity, saveDisplayName } from "../src/sync/guest.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
}

describe("loadGuestIdentity", () => {
  it("REQ-002: первый заход — выдаётся новый guestId и сохраняется под retro.guestId", () => {
    const storage = memoryStorage();
    const identity = loadGuestIdentity(storage, () => "guest-1");

    expect(identity.guestId).toBe("guest-1");
    expect(identity.displayName).toBeNull();
    expect(storage.data.get("retro.guestId")).toBe("guest-1");
  });

  it("REQ-002: повторный заход — тот же guestId, newId не вызывается", () => {
    const storage = memoryStorage({ "retro.guestId": "guest-old" });
    let calls = 0;
    const identity = loadGuestIdentity(storage, () => {
      calls++;
      return "guest-new";
    });

    expect(identity.guestId).toBe("guest-old");
    expect(calls).toBe(0);
  });

  it("REQ-002: сохранённое имя возвращается, saveDisplayName пишет в retro.displayName", () => {
    const storage = memoryStorage();
    loadGuestIdentity(storage, () => "g");
    saveDisplayName(storage, "Аня");

    expect(storage.data.get("retro.displayName")).toBe("Аня");
    expect(loadGuestIdentity(storage, () => "other")).toEqual({
      guestId: "g",
      displayName: "Аня",
    });
  });

  it("REQ-002: storage бросает (приватный режим) — не падаем, возвращаем свежий guestId", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };

    const identity = loadGuestIdentity(broken, () => "fresh");
    expect(identity.guestId).toBe("fresh");
    expect(() => saveDisplayName(broken, "x")).not.toThrow();
  });

  it("REQ-002: storage читается, но запись бросает — guestId всё равно возвращается", () => {
    const readOnly = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(loadGuestIdentity(readOnly, () => "fresh").guestId).toBe("fresh");
  });
});
