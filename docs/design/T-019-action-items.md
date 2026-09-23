# T-019: action items — права на сервере и интерфейс

REQ-017 (кр. 1–2), REQ-018, REQ-019 (кр. 1). Закрывает вторую половину находки независимой проверки 2026-09-22 (поля `assignee`/`done`/удаление action item проходили без проверки прав).

## 1. Сервер

### Права (`packages/server-core/src/rules/permissions.ts`)
`classifyAction`: запись (`entries[0]`) в сущность вида `action` — любое поле (`text`, `assignee`, `done`, `deleted`) → `"editAction"`. `StickerAction` получает `"editAction"`. `checkPermission`: `owner`/`facilitator` — `ok`; `viewer` — `forbidden`; `participant` — фаза ∈ {`discuss`, `actions`} → `ok`, иначе `wrong_phase`; владение не проверяется (как `createAction`).

### Список участников (`GET /api/boards/:id/members`, `apps/server`)
Доступ по `protocol.md` § 7 (обновлено): `owner`/`facilitator` — всегда; `participant`/`viewer` — только когда доска раскрыта (`phase !== "collect"`), до этого `403 forbidden`. Остальное как в T-018.

## 2. Контроллер (`apps/web/src/board-controller.ts`)
`createAction(text)` (обрезка; пустой → `{ok:false, reason:"invalid_intent"}` без вызова ядра), `editAction(id, text)` (то же правило), `assign(id, guestId | null)`, `setDone(id, done)`. Удаление — существующий `remove(id)`. Список — `state.view.actions` (уже есть).

## 3. Компоненты (`src/ui/`)
- `ActionItemRow`, props `{ action: ActionView; members: { guestId: string; displayName: string }[]; readOnly: boolean; onEditText(text: string): void; onAssign(guestId: string | null): void; onSetDone(done: boolean): void; onDelete(): void }`. Корень `<li data-action-id={id}>`; варианты текста — `<p data-variant>`. Конфликт (`action.conflict`): `role="alert"` «Конфликт правок» и (не `readOnly`) у каждого варианта «Оставить этот вариант» → `onEditText(вариант)`. Чекбокс `aria-label="Выполнено"` (`checked = done`; `onChange` → `onSetDone(новое значение)`; в `readOnly` — `disabled`). Ответственный: не `readOnly` — `<select aria-label="Ответственный">`: «Не назначен» (значение пустое → `onAssign(null)`) и участники (`onAssign(guestId)`), выбрано — текущий; `readOnly` — текст «Ответственный: {имя}» / «Ответственный: не назначен»; `guestId` не из `members` → «Ответственный: неизвестный участник». Не `readOnly`: «Редактировать» → `<textarea aria-label="Текст действия">` (первый вариант), «Сохранить» (`onEditText`, закрывает), «Отмена»; «Удалить» → `onDelete`. Тексты и имена — только текст (XSS). `readOnly` — ни одной кнопки и поля ввода.
- `AddActionForm`, props `{ onAdd(text: string): void }`: `<textarea aria-label="Новое действие">`, кнопка «Добавить действие»; пустое/пробельное — `onAdd` не вызывается, `role="alert"`; после успеха очищается.
- `BoardView`: секция `<section aria-label="Действия">` в фазах `discuss` и `actions`: список `ActionItemRow` (`readOnly` — для `viewer` или если у роли `participant` фаза не позволяет; для `owner`/`facilitator` всегда редактируемо) и `AddActionForm` (не `viewer`). Участников загружает `loadMembers`, когда список доступен (владелец/фасилитатор всегда, остальные после `reveal`), перезагружает при смене фазы.
