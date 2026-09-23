# T-017: голосование в интерфейсе — дизайн

REQ-015 (кр. 1, 3–5). Лимит и права проверяет сервер (V6/V7, `vote_limit` → `reject`); интерфейс только показывает остаток и отправляет голоса. Голоса за группу — вместе с группами (T-016).

## 1. `BoardController`

`BoardState` получает:
- `voteLimit: number | null` — `meta.voteLimit` (`null` до `welcome`);
- `myVotes: Record<EntityId, number>` — число собственных **активных** голосов по каждой цели (`activeVotes(full)`, `vote.user === voterToken`; включая ещё не подтверждённые и голоса за удалённые стикеры — они считаются в лимит, REQ-015 «Не входит»);
- `votesLeft: number | null` — `voteLimit − Σ myVotes`, не меньше 0; `null`, если `voteLimit` или `voterToken` неизвестны.

Действия (возвращают `ActResult`, отправляют и обновляют состояние, как остальные):
- `vote(target)` — `client.act({ type: "vote", target })`. Локальной проверки остатка нет: истину знает сервер (две вкладки, кр. 6), лишний голос откатится `reject` с уведомлением.
- `unvote(target)` — отзывает один из собственных активных голосов за `target` (при нескольких — с наибольшим счётчиком dot, детерминированно): `client.act({ type: "unvote", voteDot, target })`. Нет своих голосов за цель → `{ ok: false, reason: "invalid_intent" }` без вызова ядра.

## 2. Компоненты (`src/ui/`)

- `VoteControls`, props `{ total: number; mine: number; remaining: number; interactive: boolean; onVote(): void; onUnvote(): void }`. Корень `<div aria-label="Голоса">`. Всегда: `<span data-total>` с текстом «Голоса: {total}» (кр. 5 — суммарное число); при `mine > 0` — `<span data-mine>` «Мои: {mine}» (свои видны только у себя; кто ещё голосовал — не показывается). При `interactive`: кнопка `aria-label="Отдать голос"` (`disabled`, если `remaining <= 0`) → `onVote`; кнопка `aria-label="Отозвать голос"` (`disabled`, если `mine === 0`) → `onUnvote`. Не `interactive` — ни одной кнопки.
- `VoteBudget`, props `{ remaining: number; limit: number }`: `<p role="status" aria-label="Оставшиеся голоса">` с текстом «Осталось голосов: {remaining} из {limit}».
- `BoardView`: `VoteBudget` — в фазе `vote`, если роль не `viewer` и `votesLeft !== null`; `VoteControls` у каждого стикера в фазе `vote` и после неё (`discuss`, `actions`) как показ суммы, `interactive` — только в `vote` и роль не `viewer` (`owner`/`facilitator` могут и вне `vote` по REQ-015, но интерфейс держит голосование в своей фазе — сервер всё равно решает).
