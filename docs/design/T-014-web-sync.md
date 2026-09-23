# T-014: браузерные адаптеры синхронизации — дизайн

Основание: ADR-0011, REQ-002 (кр. 1, 3–4), REQ-023 (кр. 1–2), REQ-024 (кр. 1). Логика синхронизации целиком в `@retro/client-core` (T-028); в `apps/web` — только адаптеры, каждый принимает браузерные API параметром (тестируется в node c `fake-indexeddb`, без jsdom).

## 1. `packages/client-core` — возобновление

- `OutboxStore.save(entries, clock)` — второй аргумент `clock: Clock` (актуальные часы клиента). Причина: `actorId` и счётчик dot нельзя вывести из `P` (отклонённые/подтверждённые dot не в очереди; повтор dot после `reject` недопустим). ADR-0011 дополняется этим уточнением. `createMemoryOutboxStore` и `packages/sim` не ломаются (лишний аргумент игнорируется).
- `ClientCorePorts.resume?: { actorId, clock, pending }`. Если задан: `newActorId` НЕ вызывается; `actorId = resume.actorId`, `clock = resume.clock`, `P = resume.pending` дословно (без пересборки через `act()`, без `outbox.save` при создании). Первый `hello` несёт `resume.actorId`, после `welcome` очередь уходит в исходном порядке. Следующий `act` продолжает счётчик из `resume.clock`.

## 2. `apps/web/src/sync/guest.ts` (REQ-002 кр. 1, 3, 4)

`loadGuestIdentity(storage, newId): { guestId: string; displayName: string | null }` — `storage` = `Pick<Storage, "getItem" | "setItem">`. Ключи `retro.guestId`, `retro.displayName`. Нет `guestId` → `newId()` и запись; есть → тот же. `saveDisplayName(storage, name)`. Исключение из `storage` (приватный режим) не роняет: возвращается свежий `guestId` без сохранения.

## 3. `apps/web/src/sync/idb-outbox.ts`

`openIdbOutbox(factory: IDBFactory, key: string): Promise<IdbOutbox>`; `IdbOutbox = OutboxStore & { load(): Promise<{actorId, clock, pending} | null>; flush(): Promise<void>; close(): void }`.
- `save(entries, clock)` синхронный (контракт `OutboxStore`), запись в IndexedDB — асинхронно, строго по порядку вызовов; побеждает последний вызов. `flush()` ждёт завершения всех поставленных записей.
- `load()` → `{ actorId: clock.actor, clock, pending }` из последней записи; `null`, если записи нет **или `pending` пуст** (ADR-0011: актор продолжается, только пока очередь не пуста).
- `PendingEntry`/`Clock` хранятся структурно (structured clone), после `load` глубоко равны сохранённым.
- Разные `key` — независимые записи.

## 4. `apps/web/src/sync/session.ts` (ADR-0011)

`startSession(deps): Promise<Session>`, `deps = { boardId, storage, idb: IDBFactory | undefined, locks: LockManagerLike | undefined, newId: () => string }`, `LockManagerLike = { request(name, options: { ifAvailable: true }, callback: (lock: object | null) => Promise<unknown>): Promise<unknown> }`.
`Session = { guestId, displayName, ports: ClientCorePorts, resumed: boolean, persistent: boolean, release(): void }`.
- Имя лока `retro:${boardId}:${guestId}`, `ifAvailable`. Лок держится до `release()` (callback возвращает промис, который завершается в `release`).
- Лок получен и `idb` есть: очередь в IndexedDB по ключу имени лока; `load()` непустой → `ports.resume` задан, `resumed: true`, `newActorId` не вызывается; иначе свежий актор (`newActorId` = `newId`), `resumed: false`, `persistent: true`.
- Лок занят (`callback(null)`), `locks`/`idb` недоступны: новый актор, пустая очередь **в памяти** (`createMemoryOutboxStore`), `persistent: false`, `resumed: false` — вторая вкладка не пишет в чужую персистентную запись.
- `ports.newCommandId` = `newId`.

## 5. `apps/web/src/sync/connection.ts` (REQ-023, ADR-0009)

`connectSync(opts): Connection`; `opts = { client: SyncClient, url: string, createSocket: (url) => SocketLike, setTimer, clearTimer, onChange?: () => void, backoff?: { baseMs: 500, maxMs: 30000 } }`; `SocketLike = { send(data: string): void; close(): void; onopen; onmessage: (e: {data: string}) => void; onclose; onerror }` (присваиваемые свойства, как у `WebSocket`).
`Connection = { send(strings: readonly string[]): void; close(): void }`.
- Старт: сокет создаётся сразу. `onopen` → все строки `client.connected()` уходят в сокет.
- `onmessage` → `client.receive(data)`, результат отправляется в сокет по порядку. Исключение из `receive` (ошибка протокола) → сокет закрывается, как обычный разрыв. После каждого сообщения — `onChange`.
- `onclose` → `client.disconnected()`, `onChange`, переподключение через `min(maxMs, baseMs·2^n)` (n — число неудач подряд; без случайности). n сбрасывается, когда `client.inspect().status === "welcomed"`.
- `send(strings)` (результат `client.act`/`client.command` от интерфейса) отправляет только в открытый сокет; иначе строки не теряются — они уже в очереди `P` и уйдут после `welcome`; команды офлайн не копятся (контракт `client-core`).
- `close()` — закрывает сокет, отменяет таймер, больше не переподключается; `client.disconnected()` вызывается.
- URL — `ws(s)://<host>/api/boards/:boardId/ws`; сборка URL — `buildWsUrl(location, boardId)` в том же модуле (`https:` → `wss:`).
