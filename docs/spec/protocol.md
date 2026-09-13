# Протокол синхронизации и REST API

- **Статус:** первая версия, 2026-09-13 (веха В2)
- **Источники:** `docs/spec/consistency-model.md` (§ 6 реплики, § 7 правила приёма V1–V7), `docs/spec/requirements.md`
- **Реализация схем:** `packages/protocol` (zod). Схема — источник истины для формы сообщений; этот документ — для смысла и последовательности.

## 1. Транспорт и лимиты

- REST: JSON поверх HTTP, префикс `/api`.
- Синхронизация: один WebSocket на доску — `GET /api/boards/:boardId/ws`.
- Каждое WS-сообщение — JSON-объект с полем `type`. Версия протокола: `1`.
- Сервер проверяет заголовок `Origin` при установке WS-соединения.

| Лимит | Значение | Нарушение |
|---|---|---|
| размер WS-сообщения | ≤ 16 KiB | `too_large`, соединение закрывается |
| текст стикера / action item | 1–2000 символов после обрезки пробелов | `invalid_shape` |
| название группы | 1–200 символов | `invalid_shape` |
| отображаемое имя | 1–50 символов | `invalid_shape` |
| записей в одной дельте | ≤ 16 | `invalid_shape` |
| перекрытий в одной дельте | ≤ 64 | `invalid_shape` |
| `frac` | 1–64 символа `[0-9A-Za-z]` | `invalid_shape` |
| лимит голосов доски | 1–10, по умолчанию 3 | REST 400 |

## 2. Идентификаторы

| Имя | Формат | Время жизни | Кто создаёт |
|---|---|---|---|
| `guestId` | UUID | пока жив localStorage браузера (REQ-002) | клиент |
| `actorId` | UUID | одна загрузка страницы (`consistency-model.md` § 1.1) | клиент |
| `boardId` | UUID | пока доска не удалена окончательно | сервер |
| `EntityId` | `${actorId}:${counter}` | как у сущности | = dot операции создания |
| `voterToken` | непрозрачная строка | как у доски | сервер: HMAC(секрет, `boardId` + `guestId`) |

**Анонимность голосов (REQ-015, кр. 5).** В поле `Vote.user` на проводе и в состоянии CRDT лежит `voterToken`, а не `guestId`. Все реплики хранят одно и то же состояние (сходимость не нарушается), но по токену нельзя узнать человека. Свой `voterToken` клиент получает в `welcome` и по нему считает свои голоса.

**Авторство стикеров (REQ-006).** Автор хранится только на сервере, в CRDT его нет. До `reveal` сервер не отправляет чужие сущности вовсе (проекция `proj_u`); после `reveal` имена авторов приходят в метаданных (`BoardMeta.authors`).

## 3. Проводной формат дельты — `WireDelta`

```ts
{
  created:    { id: EntityId, kind: "sticker" | "group" | "action" }[],
  entries:    { key: { entity, field }, dot: { actor, counter }, stamp: { lamport, actor }, value }[],
  supersedes: { key: { entity, field }, dot: { actor, counter } }[],
  votes:      { dot, user: voterToken, target: EntityId }[],
  unvotes:    { dot, target: EntityId }[],
}
```

- Массивы вместо множеств; порядок элементов не значим, повторы допустимы (слияние идемпотентно).
- Домен `value` зависит от `key.field` — таблица `consistency-model.md` § 1.4: `text`/`title` — строка, `color` — палитра, `place` — `{ column, frac }`, `group` — `EntityId | null`, `assignee` — `guestId | null`, `deleted`/`done` — boolean.
- Дельта от клиента содержит **ровно одну** операцию: все элементы несут один dot (V1, V2).

## 4. Сообщения клиент → сервер

| `type` | Поля | Смысл |
|---|---|---|
| `hello` | `protocol: 1`, `guestId`, `displayName`, `actorId`, `lastSeq: number \| null` | первое сообщение после подключения |
| `op` | `delta: WireDelta` | одна операция над доской (§ 3 `consistency-model.md`) |
| `command` | `id` (строка клиента), `command` | действие над метаданными, не CRDT (§ 3.2) |

Варианты `command`:

| `command.type` | Поля | REQ |
|---|---|---|
| `setPhase` | `phase: collect \| group \| vote \| discuss \| actions` | REQ-004 |
| `grantFacilitator` | `guestId` | REQ-003 |
| `resetVotes` | — | REQ-016 |
| `startTimer` | `seconds: 30..3600` | REQ-019 |
| `stopTimer` | — | REQ-019 |

## 5. Сообщения сервер → клиент

| `type` | Поля | Когда |
|---|---|---|
| `welcome` | `role`, `voterToken`, `meta: BoardMeta`, `snapshot: { upToSeq, state: WireDelta } \| null`, `ops: { seq, delta }[]` | ответ на `hello`; всё — уже в проекции `proj_u` |
| `ack` | `dot`, `seq` | своя операция принята (или была принята раньше — повтор, V1) |
| `reject` | `dot`, `reason`, `message` | своя операция отклонена (REQ-024) |
| `op` | `seq`, `delta` | чужая принятая операция, в проекции получателя |
| `meta` | `meta: BoardMeta` | изменились фаза, таймер, роли или авторы |
| `commandResult` | `id`, `ok`, `reason?`, `message?` | ответ на `command` |
| `error` | `reason`, `message` | фатальная ошибка; сервер закрывает соединение |

`BoardMeta`: `boardId`, `title`, `phase`, `revealed: boolean`, `voteLimit`, `timer: { endsAt: ISO-8601 } | null`, `authors: Record<EntityId, displayName>` (пусто до `reveal`).

`role`: `owner | facilitator | participant | viewer`.

### Причины отказа — `reason`

| `reason` | Правило | Пример |
|---|---|---|
| `stale_dot` | V1 | счётчик не больше последнего принятого, и такого dot в журнале нет |
| `invalid_shape` | V2 | не одна операция, значение вне домена, лимиты § 1 |
| `unknown_target` | V3 | правка несуществующей сущности |
| `unjustified_supersede` | V4 | перекрытие записи, которой нет или которая «новее» |
| `invalid_stamp` | V5 | метка не от этого актора, не растёт или слишком далеко в будущем |
| `forbidden` | V6 | роль не позволяет действие (`CLAUDE.md` § 5) |
| `wrong_phase` | V6 | действие не разрешено в текущей фазе |
| `vote_limit` | V7 | голосов уже N |
| `not_own_vote` | V7 | отзыв чужого или уже отозванного голоса |
| `irreversible_phase` | REQ-004 | попытка вернуться в `collect` |
| `rate_limited` | В5 | превышен лимит частоты |
| `too_large` | § 1 | сообщение больше лимита |

## 6. Последовательности

**Подключение.** Клиент → `hello`. Сервер связывает `actorId` с `guestId`, считает роль, отвечает `welcome`: если `lastSeq` не задан или старше последнего снапшота — снапшот и хвост журнала, иначе только операции с `seq > lastSeq`.

**Операция.** Клиент применяет дельту локально и кладёт в очередь (`consistency-model.md` § 6) → `op`. Сервер проверяет V1–V7 по порядку; при успехе пишет в журнал, отвечает автору `ack`, остальным — `op` в их проекции. При отказе — `reject` только автору.

**Переподключение (REQ-023).** Клиент открывает соединение, шлёт `hello` с последним известным `seq`, затем отправляет очередь **в исходном порядке**. Повтор уже принятой операции даёт `ack` с исходным `seq` без повторного применения.

**Reveal (REQ-004, REQ-006).** Первый `setPhase` из `collect` делает `revealed = true`. Сервер рассылает всем `meta` с авторами и `op` с сущностями, которые получатель раньше не видел.

## 7. REST

Идентификация — заголовок `X-Guest-Id: <guestId>` (REQ-002; риск подмены принимается и разбирается на В5). Ошибки — `{ error: <код>, message }`.

| Метод и путь | Тело / ответ | Кто | REQ |
|---|---|---|---|
| `POST /api/boards` | `{ title, displayName, voteLimit? }` → `201 { boardId }` | любой гость | REQ-001 |
| `GET /api/boards/:boardId` | → `200 BoardMeta` без `authors` до `reveal`; `404`, если удалена | любой | REQ-002 |
| `GET /api/boards/:boardId/export` | → `200 { columns, actionItems }`; `409 not_revealed` до `reveal` | любая роль | REQ-020 |
| `DELETE /api/boards/:boardId` | `{ confirm: boardId }` → `202`; `403` не владельцу | owner | REQ-021 |
| `POST /api/boards/:boardId/restore` | → `200`; `410`, если прошло 7 дней | owner | REQ-021 |
