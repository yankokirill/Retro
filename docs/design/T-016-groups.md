# T-016: группы — права на сервере и интерфейс

REQ-011 (кр. 1), REQ-012, REQ-013. Закрывает находку независимой проверки 2026-09-22 (создание/переименование группы проходило без проверки прав).

## 1. Сервер: права на группы (`packages/server-core/src/rules/permissions.ts`)

`classifyAction` перестаёт возвращать `null` для групп:
- дельта с `created[0].kind === "group"` → `"createGroup"`;
- запись (`entries[0]`) в сущность вида `group`, любое поле (`title`, `place`, `deleted`) → `"editGroup"`. Пересечение с уже существующей веткой стикеров не меняется.

`StickerAction` получает `"createGroup" | "editGroup"`; `checkPermission` (владение не используется — у группы нет автора):
- `owner`/`facilitator` — всегда `ok`; `viewer` — `forbidden`;
- `participant` — фаза `group` → `ok`; иначе `wrong_phase`.
Матрица — `docs/security/permissions.md` (строка «создать/переименовать группу, …»). Причины отказа те же, что у остальных действий V6. Остальное (`setGroup` у стикера — `assignGroup`) не меняется.

## 2. Контроллер (`apps/web/src/board-controller.ts`)

Новые действия (`ActResult`, как прочие): `createGroup(column, title)` — в конец колонки (`frac = fracBetween(frac последнего, null)`), название обрезается по краям, пустое → `{ok:false, reason:"invalid_intent"}` без вызова ядра; `renameGroup(id, title)` (то же правило пустого названия); `setGroup(cardId, groupId | null)`. Удаление/восстановление/перемещение группы — существующие `remove`/`restore`/`moveTo` (они работают с любой сущностью). `BoardState.trash[].text` для группы уже берёт `title`.

## 3. Компоненты (`apps/web/src/ui/`)

- `GroupItem`, props `{ group: GroupView; readOnly: boolean; onRename(title: string): void; onDelete(): void; children?: ReactNode }`. Корень `<section data-group-id={id}>`; каждый вариант названия — `<h3 data-variant>`. Конфликт (`group.conflict`): `role="alert"` с текстом «Конфликт названий» и (не `readOnly`) у каждого варианта кнопка «Оставить это название» → `onRename(вариант)`. Не `readOnly`: «Переименовать» → `<input aria-label="Название группы">` c первым вариантом, «Сохранить» (`onRename(значение)`, закрывает), «Отмена»; «Удалить группу» → `onDelete`. `readOnly` — ни одной кнопки и поля. `children` — внутри секции (стикеры группы). Название — только текст (XSS).
- `AddGroupForm`, props `{ onAdd(title: string): void }`: `<input aria-label="Новая группа">`, кнопка «Создать группу»; пустое/пробельное — `onAdd` не вызывается, `role="alert"`; после успеха поле очищается.
- `GroupSelect`, props `{ groups: { id: string; title: string }[]; current: string | null; onChange(groupId: string | null): void }`: `<select aria-label="Группа">`, первая опция «Без группы» (значение пустое → `null`), далее по одной на группу (текст — название); выбранное — `current`.
- `BoardView`: элементы колонки — стикеры и группы (`GroupItem` со стикерами внутри и `VoteControls` группы); `AddGroupForm` в колонке (не `viewer`); у стикера `GroupSelect` (не `viewer`); перетаскивание стикера на группу → `setGroup(стикер, группа)`; на колонку или стикер вне группы — если стикер в группе, сначала `setGroup(стикер, null)`.
