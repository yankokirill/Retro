# T-018: фазы, роли и таймер в интерфейсе — дизайн

REQ-003 (кр. 2), REQ-004 (кр. 3), REQ-019 (кр. 2). Серверные команды — T-030 (`protocol.md` § 6). Права в интерфейсе — подсказка; решает сервер, отказ виден пользователю.

## 1. Сервер: `GET /api/boards/:boardId/members`

`protocol.md` § 7. Схема ответа `membersResponseSchema` в `@retro/protocol` (`rest.ts`): `{ members: { guestId, displayName, role }[] }`. Правила: нет `X-Guest-Id` → 400; `boardId` не UUID → 400; доски нет/удалена или у гостя нет записи → 404; роль `participant`/`viewer` → 403 `{ error: "forbidden" }`; иначе 200. Порядок — по `joined_at`, при равенстве по `guestId`. Владелец в списке (он заносится в `members` при создании доски).

## 2. `client-core`: отказы команд

`ClientSnapshot.commandFailures: readonly { id: string; reason: RejectReason }[]` — по одному элементу на каждое полученное `commandResult` с `ok: false` (в порядке получения, `reason` из сообщения; если его нет — `"invalid_shape"`); `ok: true` ничего не добавляет. Не сбрасывается ни `disconnected()`, ни `welcome`. `id` — тот, что вернул `ports.newCommandId()` при отправке.

## 3. `apps/web`: контроллер и API

- `Api.listMembers(boardId): Promise<{ guestId, displayName, role }[]>` (`x-guest-id`; не 2xx → `ApiError`).
- `BoardController`: `setPhase(phase: Phase)`, `grantFacilitator(guestId: string)`, `startTimer(seconds: number)`, `stopTimer()` — каждая отправляет `client.command(...)` через `send` и возвращает `boolean` (`false` — команда не ушла: клиент не `welcomed`). Каждая новая запись `commandFailures` превращается в `notice` (текст — `describeRejection(reason)`), без дублей при повторных `refresh`.
- `describeRejection` знает и `unknown_target` («Участник не найден на доске»), `irreversible_phase`, `wrong_phase`, `forbidden` — уже есть; добавить `unknown_target` явно.

## 4. Компоненты (`src/ui/`) — контракт для тестов

- `PhaseBar`, props `{ phase: Phase; role: Role | null; onSetPhase(phase: Phase): void }`. Текущая фаза — `<p role="status">` c русским названием: «Сбор», «Группировка», «Голосование», «Обсуждение», «Действия». Для `owner`/`facilitator` — кнопки перехода во все остальные фазы (имена кнопок — названия фаз); текущая фаза — кнопка `aria-current="step"` и `disabled`; «Сбор» `disabled` вне `collect` (необратимо, REQ-004 кр. 2). Первый уход из `collect`: клик по фазе не вызывает `onSetPhase`, а показывает `role="alertdialog"` с текстом «Раскрыть стикеры и их авторов? Это необратимо» и кнопками «Подтвердить» (вызывает `onSetPhase(выбранная)`, закрывает диалог) и «Отмена». Переходы вне `collect` — сразу. `participant`/`viewer`/`null` — только текст фазы, ни одной кнопки.
- `TimerPanel`, props `{ phase: Phase; timer: { endsAt: string } | null; role: Role | null; now: number; onStart(seconds: number): void; onStop(): void }`. Вне `discuss` — ничего не рендерит (`null`). В `discuss` с таймером: `<p role="timer">` с остатком `mm:ss` (`ceil` до секунды, `now` — миллисекунды эпохи); остаток ≤ 0 → текст «Время вышло» в `role="status"`, без кнопок смены фазы. Без таймера — «Таймер не запущен». Для `owner`/`facilitator`: `<input aria-label="Минуты" type="number">` (по умолчанию 5, 1–60) и кнопка «Запустить таймер» → `onStart(минуты·60)`; при идущем/истёкшем таймере ещё кнопка «Остановить таймер» → `onStop()`. Остальным — только показ.
- `FacilitatorPanel`, props `{ members: { guestId: string; displayName: string; role: Role }[]; onGrant(guestId: string): void }`. `<section aria-label="Участники">`; каждый участник — `<li>` c именем (как текст) и ролью словами («Владелец», «Фасилитатор», «Участник», «Наблюдатель»); для `participant` и `viewer` — кнопка `aria-label="Назначить фасилитатором: <имя>"` → `onGrant(guestId)`; у `owner`/`facilitator` кнопки нет.
- `BoardView` собирает их: `PhaseBar` и `TimerPanel` над колонками, `FacilitatorPanel` только для `owner` (данные — `loadMembers` prop, обновляются после успешного `grantFacilitator`); `now` тикает раз в секунду.
