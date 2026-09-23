# T-015: доска и стикеры в интерфейсе — дизайн

REQ-005 (кр. 1), REQ-007 (показ конфликта), REQ-008, REQ-009, REQ-010 (кр. 1). Зависит от T-014 (адаптеры `apps/web/src/sync`). Логика вынесена в модули без DOM (тестируются в node), компоненты — тонкие и тестируются в jsdom (`// @vitest-environment jsdom` в файле).

Права в интерфейсе — только подсказка: `viewer` не видит кнопок; остальным роли/фазы решает сервер, отказ показывается пользователем (REQ-024 кр. 2). Авторство скрыто до `reveal`, поэтому «чужой/свой стикер» клиент не различает.

## 1. `src/frac.ts`

`fracBetween(before: string | null, after: string | null): string` — `frac` строго между `before` и `after` (сравнение строк `<`, алфавит `0-9A-Za-z` в порядке кодов). `null` — край. Результат: 1–64 символа алфавита. `(null, null)` → любая корректная строка. Предусловие `before < after`. Если вставить строго между нельзя (равные соседи или исчерпаны 64 символа) — возвращается `before ?? after`. Последовательная вставка «в конец» (`fracBetween(last, null)`) и «в начало» (`fracBetween(null, first)`) сотни раз подряд не превышает 64 символа для разумного числа вставок (≥ 200) и сохраняет порядок.

## 2. `src/route.ts`

`parseRoute(pathname): Route`: `/` → `{name:"home"}`; `/j/<token>` → `{name:"join", linkToken}`; `/b/<uuid>` → `{name:"board", boardId}`; иначе `{name:"notFound"}`. Хвостовой `/` допустим. `boardPath(boardId)`, `joinPath(linkToken)` — обратные.

## 3. `src/api.ts`

`createApi({ fetch, guestId }): Api` (`fetch` — как глобальный). Каждый запрос несёт заголовок `x-guest-id`.
- `createBoard({ title, displayName, voteLimit? }): Promise<{ boardId, participantLink, viewerLink }>` — `POST /api/boards`, JSON.
- `join(linkToken, displayName): Promise<{ boardId, role }>` — `GET /api/boards/join/<token>?displayName=<encoded>`.
- `getBoard(boardId): Promise<(BoardMeta & { role }) | null>` — `GET /api/boards/<id>`; `404` → `null`.
- Ответ не 2xx (кроме 404 у `getBoard`) → `ApiError { status, error, message }` (тело — `ErrorResponse`, не разбирается → `error: "unknown"`). Ответ не по схеме `@retro/protocol` → ошибка.

## 4. `src/board-controller.ts`

`createBoardController({ client, send }): BoardController`; `client` — `SyncClient`, `send(lines)` — отправка строк (обычно `Connection.send`).
`BoardController = { store: StoreApi<BoardState> (zustand/vanilla), refresh(): void, addSticker(column, text, color), editText(id, text), setColor(id, color), moveTo(id, column, index), remove(id), restore(id) }`; действия возвращают `ActResult`, отправляют `result.send` через `send`, затем делают `refresh()`.
`BoardState = { status: ClientStatus; role: Role | null; meta: BoardMeta | null; view: View; trash: { id, text: string[] }[]; pendingCount: number; notices: { id: number; text: string }[] }`. `refresh()` перечитывает `client.inspect()`; в `notices` добавляется по сообщению на каждую новую `rejections[i]` (текст — `describeRejection(reason)`, счётчик не дублирует уже показанные); `dismissNotice(id)`.
- `addSticker(column, text, color)` — в конец колонки: `frac = fracBetween(frac последнего элемента колонки, null)`. Текст обрезается по краям; пустой → `{ok:false, reason:"invalid_intent"}` без вызова ядра.
- `moveTo(id, column, index)` — `index` в списке целевой колонки **без** самого `id`; `frac` между соседями (`place` соседей берётся из `client.inspect().full` через `winner(state, {entity, field:"place"})`).
- `trash[i].text` — все видимые варианты `text` (`values`), для группы — `title`.
- `src/messages.ts`: `describeRejection(reason: RejectReason): string` — непустая русская фраза для каждой причины (`forbidden`, `wrong_phase`, `vote_limit`, … из `protocol.md`); неизвестная причина → общая фраза.

## 5. Компоненты (`src/ui/`)

Доступные имена и роли — единственный контракт для тестов.
- `CardItem` (`src/ui/CardItem.tsx`), props `{ card: CardView; readOnly: boolean; onEditText(text: string): void; onSetColor(color: Color): void; onDelete(): void }`. Корень `<article data-card-id={id} data-color={color}>`; каждый вариант текста — `<p data-variant>`. Конфликт (`card.conflict`): элемент `role="alert"` с текстом «Конфликт правок» и у каждого варианта кнопка «Оставить этот вариант» (вызывает `onEditText(вариант)`). Не `readOnly`: кнопка «Редактировать» → `<textarea aria-label="Текст стикера">` c текущим текстом (при конфликте — пустой не допускается: первый вариант) и кнопки «Сохранить» (`onEditText(значение)`, закрывает редактор) и «Отмена»; кнопка «Удалить» (`onDelete`); пять кнопок цвета `aria-label="Цвет: yellow"` … (`onSetColor`). `readOnly` — ни одной кнопки. Тексты выводятся как текст (не HTML).
- `AddStickerForm`, props `{ onAdd(text: string, color: Color): void }`: `<textarea aria-label="Новый стикер">`, кнопки цвета `aria-label="Цвет: …"`, кнопка «Добавить». Пустой/пробельный текст — `onAdd` не вызывается, показывается `role="alert"`. После успешного добавления поле очищается.
- `TrashPanel`, props `{ items: { id: string; text: string[] }[]; readOnly: boolean; onRestore(id: string): void }`: `<aside aria-label="Корзина">`; пусто → текст «Корзина пуста»; иначе `<li data-card-id>` с вариантами текста и (не `readOnly`) кнопкой «Восстановить».
