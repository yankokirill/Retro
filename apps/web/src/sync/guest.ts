// Гостевая личность — REQ-002 кр. 1, 3, 4: guestId живёт в localStorage браузера.

type GuestStorage = Pick<Storage, "getItem" | "setItem">;

const GUEST_ID_KEY = "retro.guestId";
const DISPLAY_NAME_KEY = "retro.displayName";

function safeGet(storage: GuestStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage: GuestStorage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // Приватный режим/квота: работаем без сохранения, guestId живёт до перезагрузки.
  }
}

export function loadGuestIdentity(
  storage: GuestStorage,
  newId: () => string,
): { guestId: string; displayName: string | null } {
  let guestId = safeGet(storage, GUEST_ID_KEY);
  if (guestId === null) {
    guestId = newId();
    safeSet(storage, GUEST_ID_KEY, guestId);
  }
  return { guestId, displayName: safeGet(storage, DISPLAY_NAME_KEY) };
}

export function saveDisplayName(storage: GuestStorage, name: string): void {
  safeSet(storage, DISPLAY_NAME_KEY, name);
}
