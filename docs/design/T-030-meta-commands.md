# T-030: `grantFacilitator` и таймер обсуждения на сервере — дизайн

Спецификация — `docs/spec/protocol.md` § 6 «Команды метаданных (T-030)», REQ-003 (кр. 2–3), REQ-019 (кр. 2), REQ-027. Ядро сервера чистое (ADR-0009): время — порт.

## Изменения контрактов

- `@retro/protocol`: сообщение сервера `meta` получает необязательное поле `role: Role`.
- `@retro/client-core`: `receive(meta)` — если `role` есть, `snapshot.role := role` (кроме этого `meta` заменяется целиком, как раньше).
- `@retro/server-core`:
  - `BoardRecord.timerEndsAt: string | null` (ISO-8601, UTC).
  - `BoardStore.setTimer(boardId, endsAt: string | null): Promise<void>`; `BoardStore.setMemberRole(boardId, guestId, role: Role): Promise<void>` — меняет роль существующего участника (для несуществующего — без эффекта); после него `memberRole` возвращает новую роль.
  - `ServerCorePorts.now?: () => number` (миллисекунды эпохи). Без `now` `startTimer` отвечает `commandResult { ok: false, reason: "invalid_shape" }` (таймер недоступен), остальное работает как раньше.
  - `GuestBoardInfo.timerEndsAt`, `buildMeta`: `timer: { endsAt } | null` вместо постоянного `null`.
  - `handleCommand`: команды `grantFacilitator`, `startTimer`, `stopTimer` по `protocol.md`; `setPhase` в фазу ≠ `discuss` сбрасывает таймер до рассылки `meta`.
- `MemoryBoardStore` и `PgBoardStore` реализуют новые методы; `BoardRecord.timerEndsAt` читается из `boards.timer_ends_at` (миграция, `timestamptz null`). `apps/server/src/ws/gateway.ts` передаёт `now: () => Date.now()`.

## Поведение (ответы — `commandResult` на `id` команды)

| Команда | Отказ | Успех |
|---|---|---|
| `grantFacilitator {guestId}` | не `owner` → `forbidden`; `guestId` не участник → `unknown_target` | цель — `facilitator`; всем её подключениям `meta` (с `role: "facilitator"`); автору `commandResult ok`; повтор — `ok` |
| `startTimer {seconds}` | не owner/facilitator → `forbidden`; фаза ≠ `discuss` → `wrong_phase`; нет `now` → `invalid_shape` | `timerEndsAt = ISO(now() + seconds·1000)`, `meta` всем подписчикам, `ok` |
| `stopTimer` | не owner/facilitator → `forbidden` | `timerEndsAt = null`, `meta` всем, `ok` (без таймера — `ok`, `meta` не нужен) |
| `setPhase` → не `discuss` | (как прежде) | заодно `timerEndsAt = null` |

`meta.timer` виден при `welcome` (переподключение/перезагрузка) — REQ-027.
