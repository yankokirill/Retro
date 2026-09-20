// S1–S11 — docs/spec/simulator.md § 8, docs/design/T-005-simulator.md § 5.5.
// Каждая функция — чистая проверка над миром/наблюдением одного шага,
// возвращает `Violation | null`. Вызывающий (apply.ts/drain.ts/run.ts)
// решает, в какой момент какую функцию вызвать (таблица «Когда» § 8
// спецификации); здесь фиксируются только сигнатуры и точный смысл каждой
// проверки, без предположений о внутренностях `World`, кроме его публичной
// формы (world.ts).

import type { Dot, EntityId, State, View, Vote, WireDelta } from "@retro/crdt";
import {
  activeVotes,
  compact,
  dotKey,
  empty,
  equals,
  fromWire,
  materialize,
  merge,
} from "@retro/crdt";
import type { Phase, RejectReason } from "@retro/protocol";
import { clientMessageSchema, operationDot, serverMessageSchema } from "@retro/protocol";
import type { OpRow } from "@retro/server-core";
import { proj, visibleSame } from "./oracle.js";
import type { Violation } from "./violation.js";
import { violation } from "./violation.js";
import { addRow, checkFull, type WellFormedState } from "./well-formed.js";
import type { World } from "./world.js";

// ---------------------------------------------------------------------------
// S1 — обёртка над well-formed.ts с проставленным ID свойства.
// ---------------------------------------------------------------------------

export function checkWellFormedIncremental(
  state: WellFormedState,
  row: OpRow,
  step: number,
): Violation | null {
  const result = addRow(state, row);
  return result ? { ...result, step } : null;
}

/** Полный проход по журналу с нуля в контрольной точке — сверяется с инкрементальным результатом (§ 6 проекта). */
export function checkWellFormedFull(rows: readonly OpRow[], step: number): Violation | null {
  const result = checkFull(rows);
  return result ? { ...result, step } : null;
}

// ---------------------------------------------------------------------------
// Общее: каноническая сериализация View для сравнения экранов (§ 5.5 проекта
// — «через каноническую сериализацию, не импортируется: внутренняя функция
// crdt; в sim своя»). Поля View уже в каноническом порядке по контракту
// materialize (I3), кроме порядка ключей самой Map columns.
// ---------------------------------------------------------------------------

function canonicalView(view: View): string {
  const columns: Record<string, unknown> = {};
  for (const [column, items] of [...view.columns.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    columns[column] = items;
  }
  return JSON.stringify({ columns, trash: view.trash, actions: view.actions });
}

function boardPhase(world: World): Phase {
  return world.store.boardSync(world.boardId)?.phase ?? "collect";
}

// ---------------------------------------------------------------------------
// S2 — I6: у каждого voterToken не больше voteLimit активных голосов в X_S.
// Вызывается после каждой принятой операции.
// ---------------------------------------------------------------------------

export function checkVoteLimit(world: World, step: number): Violation | null {
  const board = world.store.boardSync(world.boardId);
  const voteLimit = board?.voteLimit ?? Number.POSITIVE_INFINITY;
  const byUser = new Map<string, number>();
  for (const vote of activeVotes(world.oracle.x)) {
    byUser.set(vote.user, (byUser.get(vote.user) ?? 0) + 1);
  }
  for (const [user, count] of byUser) {
    if (count > voteLimit) {
      return violation(
        "S2",
        step,
        `voterToken ${user} — ${count} активных голосов при voteLimit=${voteLimit}`,
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// S3 — при каждой доставке `ack` клиенту: в журнале есть строка с этим `seq`,
// содержащая операцию с этим dot (для unvote — пара (dot, target)); в
// журнале нет двух строк с одинаковым (actor, counter).
// ---------------------------------------------------------------------------

export interface AckObservation {
  readonly seq: number;
  readonly dot: Dot;
  readonly kind: "op" | "unvote";
  readonly target?: EntityId;
}

export function checkAck(world: World, ack: AckObservation, step: number): Violation | null {
  const row = world.store.opRowSync(world.boardId, ack.seq);
  if (!row) {
    return violation("S3", step, `ack ссылается на seq=${ack.seq}, которого нет в журнале`);
  }
  const rowDot = operationDot(row.delta);
  if (rowDot.actor !== ack.dot.actor || rowDot.counter !== ack.dot.counter) {
    return violation(
      "S3",
      step,
      `ack.dot (${dotKey(ack.dot)}) не совпадает с операцией строки seq=${ack.seq} (${dotKey(rowDot)})`,
    );
  }
  if (ack.kind === "unvote") {
    const [unvote] = row.delta.unvotes;
    if (!unvote || (ack.target !== undefined && unvote.target !== ack.target)) {
      return violation(
        "S3",
        step,
        `ack (unvote) на seq=${ack.seq} не находит пару (dot, target) в журнале`,
      );
    }
  }

  return checkNoDuplicateOps(world, step);
}

/** Уже просмотренная часть журнала каждого хранилища: дубли ищем только среди новых строк. */
const journalScan = new WeakMap<object, { scanned: number; keys: Set<string> }>();

/** В журнале нет двух строк с одинаковым `(actor, counter)` операции (идемпотентность, V1). */
function checkNoDuplicateOps(world: World, step: number): Violation | null {
  let scan = journalScan.get(world.store);
  if (!scan) {
    scan = { scanned: 0, keys: new Set() };
    journalScan.set(world.store, scan);
  }
  for (const r of world.store.logFrom(world.boardId, scan.scanned)) {
    scan.scanned += 1;
    const isUnvoteOnly =
      r.delta.unvotes.length > 0 &&
      r.delta.entries.length === 0 &&
      r.delta.votes.length === 0 &&
      r.delta.created.length === 0;
    if (isUnvoteOnly) continue;
    const d = operationDot(r.delta);
    const key = `${d.actor}:${d.counter}`;
    if (scan.keys.has(key)) {
      return violation("S3", step, `в журнале две строки с одинаковым (actor,counter)=${key}`);
    }
    scan.keys.add(key);
  }
  return null;
}

// ---------------------------------------------------------------------------
// S4 — в покое: для каждого клиента u, equals(compact(X_c(u)), compact(proj_u(X_S)))
// (ВС-6, docs/spec/simulator.md § 13).
// ---------------------------------------------------------------------------

/** Сколько элементов каждого компонента есть у `a` и нет у `b`; для `created` — ещё несколько id. */
interface StateDelta {
  readonly created: readonly EntityId[];
  readonly createdCount: number;
  readonly entries: number;
  readonly votes: number;
  readonly unvotes: number;
}

function onlyIn(a: State, b: State): StateDelta {
  const has = (state: State) => {
    const created = new Set<string>();
    for (const c of state.created.values()) created.add(c.id);
    const entries = new Set<string>();
    for (const e of state.entries.values()) {
      entries.add(`${e.key.entity}|${e.key.field}|${dotKey(e.dot)}`);
    }
    const votes = new Set<string>();
    for (const v of state.votes.values()) votes.add(dotKey(v.dot));
    const unvotes = new Set<string>();
    for (const u of state.unvotes.values()) unvotes.add(`${dotKey(u.dot)}|${u.target}`);
    return { created, entries, votes, unvotes };
  };
  const other = has(b);
  const created: EntityId[] = [];
  let createdCount = 0;
  for (const c of a.created.values()) {
    if (other.created.has(c.id)) continue;
    createdCount += 1;
    if (created.length < 5) created.push(c.id);
  }
  let entries = 0;
  for (const e of a.entries.values()) {
    if (!other.entries.has(`${e.key.entity}|${e.key.field}|${dotKey(e.dot)}`)) entries += 1;
  }
  let votes = 0;
  for (const v of a.votes.values()) if (!other.votes.has(dotKey(v.dot))) votes += 1;
  let unvotes = 0;
  for (const u of a.unvotes.values()) {
    if (!other.unvotes.has(`${dotKey(u.dot)}|${u.target}`)) unvotes += 1;
  }
  return { created, createdCount, entries, votes, unvotes };
}

export function checkClientsMatchOracle(world: World, step: number): Violation | null {
  const phase = boardPhase(world);
  for (let index = 0; index < world.clients.length; index++) {
    const client = world.clients[index];
    if (!client) continue;
    const guest = world.guests[client.guestIndex];
    if (!guest) continue;
    const snapshot = client.core.inspect();
    const actual = compact(snapshot.confirmed);
    const expected = compact(proj(world.oracle.x, phase, world.oracle.stickerAuthor, guest.id));
    if (!equals(actual, expected)) {
      // § 9.3: чего не хватает клиенту и что у него лишнее — иначе минимальная трасса есть,
      // а объяснения нет. `connections` нужны CLI, чтобы показать последние события клиента.
      const connections: number[] = [];
      world.connections.forEach((connection, connectionIndex) => {
        if (connection.clientIndex === index) connections.push(connectionIndex);
      });
      return violation(
        "S4",
        step,
        `клиент гостя ${guest.id}: compact(X_c) ≠ compact(proj_u(X_S))`,
        {
          client: index,
          guest: guest.id,
          role: guest.role,
          actor: snapshot.actorId,
          connections,
          missingInClient: onlyIn(expected, actual),
          extraInClient: onlyIn(actual, expected),
        },
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// S5 — в покое: клиенты с одинаковой видимостью показывают один materialize;
// после reveal — все клиенты равны materialize(X_S).
// ---------------------------------------------------------------------------

export function checkScreensAgree(world: World, step: number): Violation | null {
  const phase = boardPhase(world);
  // Экран каждого клиента считается один раз (материализация — O(состояния)), а не на каждую пару.
  const views: (string | undefined)[] = [];
  const viewOf = (index: number): string => {
    let view = views[index];
    if (view === undefined) {
      const client = world.clients[index];
      view = canonicalView(materialize(client ? client.core.inspect().confirmed : empty()));
      views[index] = view;
    }
    return view;
  };
  for (let i = 0; i < world.clients.length; i++) {
    for (let j = i + 1; j < world.clients.length; j++) {
      const ci = world.clients[i];
      const cj = world.clients[j];
      if (!ci || !cj) continue;
      const gi = world.guests[ci.guestIndex];
      const gj = world.guests[cj.guestIndex];
      if (!gi || !gj) continue;
      if (!visibleSame(world.oracle.x, phase, world.oracle.stickerAuthor, gi.id, gj.id)) continue;
      if (viewOf(i) !== viewOf(j)) {
        return violation(
          "S5",
          step,
          `клиенты гостей ${gi.id} и ${gj.id} видят одно и то же (${gi.id === gj.id ? "тот же гость" : "одинаковая видимость"}), но materialize расходится`,
        );
      }
    }
  }
  if (phase !== "collect") {
    const expected = canonicalView(materialize(world.oracle.x));
    for (let index = 0; index < world.clients.length; index++) {
      const client = world.clients[index];
      const guest = client ? world.guests[client.guestIndex] : undefined;
      if (viewOf(index) !== expected) {
        return violation(
          "S5",
          step,
          `после reveal клиент гостя ${guest?.id ?? "?"} не равен materialize(X_S)`,
        );
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// S6 — в покое: каждая операция, на которую хоть один клиент получил ack,
// присутствует в X_S. Реализовано через содержимое confirmed: confirmed
// растёт только из welcome/op (всегда из журнала) или ack (клиент сам
// строил дельту — единственный путь получить в confirmed то, чего нет в
// журнале, если сеть подделала ack, M2 § 10.2).
// ---------------------------------------------------------------------------

export function checkAckedOpsPersist(world: World, step: number): Violation | null {
  const xs = world.oracle.x;
  // Индексы X_S — один раз на вызов: поиск `[...xs.x.values()].some(...)` на каждый
  // элемент confirmed давал O(n²) на контрольную точку.
  const createdIds = new Set<string>();
  for (const c of xs.created.values()) createdIds.add(c.id);
  const entryKeys = new Set<string>();
  for (const e of xs.entries.values()) {
    entryKeys.add(`${e.key.entity}|${e.key.field}|${dotKey(e.dot)}`);
  }
  const voteDots = new Set<string>();
  for (const v of xs.votes.values()) voteDots.add(dotKey(v.dot));
  const unvoteKeys = new Set<string>();
  for (const u of xs.unvotes.values()) unvoteKeys.add(`${dotKey(u.dot)}|${u.target}`);

  for (const client of world.clients) {
    const guest = world.guests[client.guestIndex];
    const confirmed = client.core.inspect().confirmed;
    for (const created of confirmed.created.values()) {
      if (!createdIds.has(created.id)) {
        return violation(
          "S6",
          step,
          `клиент гостя ${guest?.id ?? "?"}: created ${created.id} подтверждён локально, но отсутствует в X_S`,
        );
      }
    }
    for (const entry of confirmed.entries.values()) {
      if (!entryKeys.has(`${entry.key.entity}|${entry.key.field}|${dotKey(entry.dot)}`)) {
        return violation(
          "S6",
          step,
          `клиент гостя ${guest?.id ?? "?"}: запись ${entry.key.entity}.${entry.key.field} (dot ${dotKey(entry.dot)}) отсутствует в X_S`,
        );
      }
    }
    for (const vote of confirmed.votes.values()) {
      if (!voteDots.has(dotKey(vote.dot))) {
        return violation(
          "S6",
          step,
          `клиент гостя ${guest?.id ?? "?"}: голос (dot ${dotKey(vote.dot)}) отсутствует в X_S`,
        );
      }
    }
    for (const unvote of confirmed.unvotes.values()) {
      if (!unvoteKeys.has(`${dotKey(unvote.dot)}|${unvote.target}`)) {
        return violation(
          "S6",
          step,
          `клиент гостя ${guest?.id ?? "?"}: отзыв голоса (dot ${dotKey(unvote.dot)}, target ${unvote.target}) отсутствует в X_S`,
        );
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// S7 — при каждой доставке reject/error и в покое: отклонённая операция
// отсутствует в журнале; причина ограничена множеством честного генератора
// — docs/spec/simulator.md § 13 ВС-7/ВС-8.
// ---------------------------------------------------------------------------

export interface RejectObservation {
  readonly kind: "reject";
  readonly dot: Dot;
  readonly reason: RejectReason | "irreversible_phase";
  /** Оставался ли этот dot в P клиента непосредственно перед обработкой ответа — для сводки/покрытия (SIM-11), не сужает допустимые причины (ВС-8). */
  readonly wasPending: boolean;
  /** Добавила ли обработка этого сообщения сервером хоть одну строку в журнал (должно быть false). */
  readonly logGrew: boolean;
}

export interface ErrorObservation {
  readonly kind: "error";
  /** true — этот `error` пришёл сразу после E9 (единственный законный случай, § 8 таблица S7). */
  readonly afterStoreFault: boolean;
}

/**
 * ВС-7 / ВС-8 (docs/spec/simulator.md § 13, H7 — найдена и разобрана при
 * реализации T-005, 2026-09-16): одно множество причин для сопоставленного
 * И устаревшего отказа. Изначально ожидалось, что причина зависит от того,
 * убрал ли клиент dot из P сам (ADR-0010) или ещё нет — но честный клиент
 * может ПОВТОРНО отправить один и тот же dot после нескольких циклов
 * разрыв→переподключение, если первый ответ на него так и не дошёл (потерян
 * при более раннем разрыве, § 4.3). Каждая копия получает от сервера СВОЙ
 * независимый ответ (findOpSeq никогда не находит непринятый dot); первая
 * ДОСТАВЛЕННАЯ копия убирает dot из P, все следующие дубликаты приходят уже
 * на устаревший — с той же причиной, какую дал бы сопоставленный отказ.
 * Различить «устарел из-за ADR-0010» от «устарел из-за дубликата» по одному
 * этому наблюдению нельзя, поэтому оба случая делят одно множество причин;
 * `unjustified_supersede` — единственная, которая по построению НЕ может
 * возникнуть у сопоставленного отказа (V4 проверяет её только для delta,
 * уже отправленной поверх чего-то, что сам клиент видел как принятое) — но
 * держать её отдельно ради этого не стоит: держать один список проще и
 * ничего не ослабляет (все причины в нём — легитимные исходы V1–V7).
 */
const HONEST_REJECT_REASONS: ReadonlySet<string> = new Set([
  "wrong_phase",
  "vote_limit",
  "unknown_target",
  "not_own_vote",
  "stale_dot",
  "unjustified_supersede",
  "irreversible_phase",
]);

export function checkReject(
  world: World,
  observation: RejectObservation | ErrorObservation,
  step: number,
): Violation | null {
  if (observation.kind === "error") {
    return observation.afterStoreFault
      ? null
      : violation("S7", step, "error получен не сразу после E9 (storeFault)");
  }
  if (observation.logGrew) {
    return violation(
      "S7",
      step,
      `обработка сообщения об отказе (dot ${dotKey(observation.dot)}) добавила строку в журнал`,
    );
  }
  if (!HONEST_REJECT_REASONS.has(observation.reason)) {
    return violation(
      "S7",
      step,
      `причина "${observation.reason}" недопустима для честного клиента (dot ${dotKey(observation.dot)}, wasPending=${observation.wasPending})`,
    );
  }
  return null;
}

/** Голос `vote` есть в журнале (оракуле) — сравнение по `(dot, target)`. */
function inJournal(world: World, vote: Vote): boolean {
  for (const known of world.oracle.x.votes.values()) {
    if (
      known.dot.actor === vote.dot.actor &&
      known.dot.counter === vote.dot.counter &&
      known.target === vote.target
    ) {
      return true;
    }
  }
  return false;
}

/** В покое: у каждого клиента confirmed/pending не содержат dot из его же rejections (§ 8 таблица S7, «в покое»). */
export function checkNoRejectedResidue(world: World, step: number): Violation | null {
  for (const client of world.clients) {
    const guest = world.guests[client.guestIndex];
    const snapshot = client.core.inspect();
    if (snapshot.rejections.length === 0) continue;
    const rejectedDots = new Set(snapshot.rejections.map((r) => dotKey(r.dot)));

    for (const created of snapshot.confirmed.created.values()) {
      if (rejectedDots.has(created.id)) {
        return violation(
          "S7",
          step,
          `клиент гостя ${guest?.id ?? "?"}: confirmed содержит created ${created.id}, чей dot есть в rejections`,
        );
      }
    }
    for (const entry of snapshot.confirmed.entries.values()) {
      if (rejectedDots.has(dotKey(entry.dot))) {
        return violation(
          "S7",
          step,
          `клиент гостя ${guest?.id ?? "?"}: confirmed содержит запись с dot из rejections`,
        );
      }
    }
    for (const vote of snapshot.confirmed.votes.values()) {
      // dot `unvote` = dot отзываемого голоса (ADR-0010): отказ на `unvote`
      // законно оставляет в `rejections` dot голоса, который при этом честно
      // лежит в `confirmed`. Из одной записи `Rejection` (без вида дельты)
      // это не отличить, поэтому остаток отклонённого голоса — только тот, что
      // отсутствует в журнале: подтверждённый `ack` голос всегда в X_S.
      if (rejectedDots.has(dotKey(vote.dot)) && !inJournal(world, vote)) {
        return violation(
          "S7",
          step,
          `клиент гостя ${guest?.id ?? "?"}: confirmed содержит голос с dot из rejections`,
        );
      }
    }
    for (const pending of snapshot.pending) {
      if (rejectedDots.has(dotKey(pending.dot))) {
        return violation(
          "S7",
          step,
          `клиент гостя ${guest?.id ?? "?"}: pending содержит dot из его же rejections`,
        );
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// S8 — в покое, для каждого снапшота E8: materialize(snapshot ⊔ хвост) и
// materialize(currentState) равны materialize(X_S).
// ---------------------------------------------------------------------------

export interface SnapshotObservation {
  readonly uptoSeq: number;
}

export function checkSnapshotConsistency(
  world: World,
  snapshots: readonly SnapshotObservation[],
  step: number,
): Violation | null {
  const expected = canonicalView(materialize(world.oracle.x));
  for (const observation of snapshots) {
    const real = world.store.latestSnapshotSync(world.boardId);
    if (!real || real.uptoSeq !== observation.uptoSeq) {
      return violation(
        "S8",
        step,
        `наблюдение утверждает uptoSeq=${observation.uptoSeq}, реальный latestSnapshot() даёт ${real?.uptoSeq ?? "null"}`,
      );
    }

    let reconstructed: State = real.state;
    for (const row of world.store.log(world.boardId)) {
      if (row.seq > real.uptoSeq) reconstructed = merge(reconstructed, fromWire(row.delta));
    }
    if (canonicalView(materialize(reconstructed)) !== expected) {
      return violation(
        "S8",
        step,
        `materialize(snapshot ⊔ хвост) ≠ materialize(X_S) для uptoSeq=${observation.uptoSeq}`,
      );
    }

    const current = world.store.currentStateSync(world.boardId);
    if (canonicalView(materialize(current.state)) !== expected) {
      return violation("S8", step, "materialize(currentState) ≠ materialize(X_S)");
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// S10 — пока фаза collect в момент отправки сервером: ни одно сообщение
// гостю u не содержит элементов, принадлежащих стикерам других гостей.
// ---------------------------------------------------------------------------

export interface OutgoingObservation {
  readonly raw: string;
  readonly recipientGuestId: string;
  /** Фаза на шаге, когда СЕРВЕР отправил это сообщение (не когда оно доставлено), § 13 п.4 перепроверки 2026-09-16. */
  readonly phaseAtSend: string;
}

function entityIdsIn(delta: WireDelta): EntityId[] {
  return [
    ...delta.created.map((c) => c.id),
    ...delta.entries.map((e) => e.key.entity),
    ...delta.supersedes.map((s) => s.key.entity),
    ...delta.votes.map((v) => v.target),
    ...delta.unvotes.map((u) => u.target),
  ];
}

export function checkNoAuthorLeak(
  world: World,
  observation: OutgoingObservation,
  step: number,
): Violation | null {
  if (observation.phaseAtSend !== "collect") return null;

  const attempt = parseServerMessage(observation.raw);
  if (!attempt.json) return null; // невалидный JSON — дело S11, не S10.
  if (!attempt.result.success) return null; // невалидная схема — дело S11, не S10.
  const message = attempt.result.data;

  const deltas: WireDelta[] = [];
  if (message.type === "op") deltas.push(message.delta);
  if (message.type === "welcome") {
    if (message.snapshot) deltas.push(message.snapshot.state);
    for (const op of message.ops) deltas.push(op.delta);
  }

  for (const delta of deltas) {
    for (const id of entityIdsIn(delta)) {
      const author = world.oracle.stickerAuthor.get(id);
      if (author !== undefined && author !== observation.recipientGuestId) {
        return violation(
          "S10",
          step,
          `сообщение гостю ${observation.recipientGuestId} содержит элемент стикера ${id} (автор ${author}) в фазе collect`,
        );
      }
    }
  }
  return null;
}

type ServerParse =
  | { readonly json: false }
  | { readonly json: true; readonly result: ReturnType<typeof serverMessageSchema.safeParse> };

// Разбор сообщений сервера — чистая функция строки; одну и ту же строку сервер
// рассылает нескольким клиентам, а S10 и S11 разбирают её по разу на получателя.
// Кэш ограничен: при переполнении сбрасывается целиком.
const serverParseCache = new Map<string, ServerParse>();
const SERVER_PARSE_CACHE_LIMIT = 4000;

function parseServerMessage(raw: string): ServerParse {
  const cached = serverParseCache.get(raw);
  if (cached) return cached;
  let entry: ServerParse;
  try {
    entry = { json: true, result: serverMessageSchema.safeParse(JSON.parse(raw)) };
  } catch {
    entry = { json: false };
  }
  if (serverParseCache.size >= SERVER_PARSE_CACHE_LIMIT) serverParseCache.clear();
  serverParseCache.set(raw, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// S11 — каждое сообщение проходит соответствующую схему; «клиент → сервер»
// дополнительно ограничено 16 KiB (ВС-5 simulator.md § 13 — лимит только на входящие).
// ---------------------------------------------------------------------------

const MAX_INCOMING_BYTES = 16 * 1024;

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function checkMessageSchema(
  direction: "toServer" | "toClient",
  raw: string,
  step: number,
): Violation | null {
  let result:
    | { readonly success: true }
    | {
        readonly success: false;
        readonly error: { readonly issues: readonly { readonly message: string }[] };
      };
  if (direction === "toClient") {
    const attempt = parseServerMessage(raw);
    if (!attempt.json)
      return violation("S11", step, `сообщение (${direction}) не является валидным JSON`);
    result = attempt.result;
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return violation("S11", step, `сообщение (${direction}) не является валидным JSON`);
    }
    result = clientMessageSchema.safeParse(parsed);
  }
  if (!result.success) {
    return violation(
      "S11",
      step,
      `сообщение (${direction}) не проходит схему: ${result.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  if (direction === "toServer" && utf8ByteLength(raw) > MAX_INCOMING_BYTES) {
    return violation(
      "S11",
      step,
      `сообщение клиент→сервер длиннее ${MAX_INCOMING_BYTES} байт (${utf8ByteLength(raw)})`,
    );
  }
  return null;
}
