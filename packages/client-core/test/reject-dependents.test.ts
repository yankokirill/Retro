// T-028, вторая итерация — REQ-024 кр. 3–5 (`docs/spec/requirements.md`,
// запись Changelog от 2026-09-15) и ADR-0010 (`docs/adr/0010-reject-cascades-to-dependent-pending-deltas.md`):
// при `reject(δ)` клиент закрывает очередь `P` от ссылок на отклонённое —
// зависимые по перекрытию дельты пересобираются со свежими dot, зависимые по
// сущности/голосу удаляются каскадом с `cause`, часы Lamport откатываются к
// максимуму реально оставшегося состояния. Контракт — JSDoc `receive()` в
// `../src/types.ts` (шаги 1–6 разбора `reject`), `Rejection.cause` там же,
// `PendingEntry.intent` в `../src/outbox.ts`.
//
// `createSyncClient` сейчас реализует ТОЛЬКО старое правило («reject убирает
// из P одну дельту с этим dot») — каждый тест ниже должен падать из-за
// неверного поведения (не той длины/состава P, отсутствия пересборки,
// отсутствия `cause`, неоткаченной метки Lamport), а не из-за ошибки в самом
// тесте или отсутствия экспорта.

import { equals } from "@retro/crdt";
import { operationDot } from "@retro/protocol";
import { describe, expect, it } from "vitest";
import { createSyncClient } from "../src/client.js";
import type { Intent } from "../src/types.js";
import {
  ackMessage,
  firstItemId,
  makeConfig,
  makePorts,
  otherActorId,
  parseOp,
  rejectMessage,
  welcomeMessage,
} from "./fixtures.js";

function welcomedClient() {
  const ports = makePorts();
  const client = createSyncClient(makeConfig(), ports);
  client.connected();
  client.receive(welcomeMessage({}));
  return { ports, client };
}

const stickerIntent = (frac: string, text: string): Intent => ({
  type: "createSticker",
  column: "start",
  frac,
  text,
  color: "yellow",
});

/**
 * Общий сценарий для кр.3: один подтверждённый стикер и три правки его text
 * подряд, ещё не подтверждённые (P = [e1, e2, e3]). Дальше каждый тест сам
 * решает, что делать с `reject(e1Dot)`.
 */
function setupEditChain() {
  const { client, ports } = welcomedClient();

  const created = client.act(stickerIntent("s", "исходный текст"));
  if (!created.ok) throw new Error("createSticker должен был пройти");
  const createdDot = operationDot(parseOp(created.send[0] as string).delta);
  client.receive(ackMessage(createdDot, 1));
  const id = firstItemId(client.inspect().view, "start");

  const e1 = client.act({ type: "editText", id, text: "v1" });
  const e2 = client.act({ type: "editText", id, text: "v2" });
  const e3 = client.act({ type: "editText", id, text: "v3" });
  if (!e1.ok || !e2.ok || !e3.ok) throw new Error("editText должен был пройти");

  const e1Dot = operationDot(parseOp(e1.send[0] as string).delta);
  const e2DotOriginal = operationDot(parseOp(e2.send[0] as string).delta);
  const e3DotOriginal = operationDot(parseOp(e3.send[0] as string).delta);

  return { client, ports, id, e1Dot, e2DotOriginal, e3DotOriginal };
}

const textValueOf = (
  entry: { delta: { entries: readonly { key: { field: string }; value: unknown }[] } } | undefined,
) => entry?.delta.entries.find((e) => e.key.field === "text")?.value;

describe("REQ-024 кр.3 — reject правки текста пересобирает зависимые по перекрытию правки того же поля", () => {
  it("REQ-024 кр.3: reject первой из трёх правок подряд пересобирает вторую и третью (новые dot, в конце P, исходный относительный порядок), экран показывает последнюю правку без ложного конфликта", () => {
    const { client, id, e1Dot, e2DotOriginal, e3DotOriginal } = setupEditChain();

    const sent = client.receive(rejectMessage(e1Dot, "forbidden"));

    const snapshot = client.inspect();
    expect(snapshot.pending).toHaveLength(2);
    const [reassembledE2, reassembledE3] = snapshot.pending;

    // Новые dot, отличные от исходных, счётчик не переиспользуется.
    expect(reassembledE2?.dot).not.toEqual(e2DotOriginal);
    expect(reassembledE3?.dot).not.toEqual(e3DotOriginal);
    expect(reassembledE2?.dot.counter).toBeGreaterThan(e3DotOriginal.counter);
    expect(reassembledE3?.dot.counter as number).toBeGreaterThan(
      (reassembledE2?.dot.counter as number) ?? 0,
    );

    // Исходный относительный порядок сохранён: v2 раньше v3.
    expect(textValueOf(reassembledE2)).toBe("v2");
    expect(textValueOf(reassembledE3)).toBe("v3");

    // Пересобранные дельты больше не перекрывают запись отклонённой e1.
    const supersedesOf = (entry: (typeof snapshot.pending)[number] | undefined) =>
      entry?.delta.supersedes.map((s) => s.dot) ?? [];
    expect(supersedesOf(reassembledE2)).not.toContainEqual(e1Dot);
    expect(supersedesOf(reassembledE3)).not.toContainEqual(e1Dot);

    // rejections — только сама отклонённая e1 (зависимость только по (в), без каскада).
    expect(snapshot.rejections).toEqual([{ dot: e1Dot, reason: "forbidden" }]);

    // Экран: последняя правка, без конфликта.
    const card = snapshot.view.columns.get("start")?.find((item) => item.id === id) as
      | { text: readonly string[]; conflict: boolean }
      | undefined;
    expect(card?.text).toEqual(["v3"]);
    expect(card?.conflict).toBe(false);

    // welcomed — по одному op на каждую пересобранную дельту, в порядке.
    expect(sent).toHaveLength(2);
    const opTexts = sent.map((raw) => {
      const op = parseOp(raw);
      return op.delta.entries.find((e) => e.key.field === "text")?.value;
    });
    expect(opTexts).toEqual(["v2", "v3"]);
  });

  it("REQ-024 кр.3: пока клиент не welcomed, receive(reject) с пересборкой возвращает [] (пересобранные уйдут со следующим welcome)", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);

    const created = client.act(stickerIntent("s", "исходный текст"));
    if (!created.ok) throw new Error("createSticker должен был пройти офлайн");
    const id = firstItemId(client.inspect().view, "start");

    const e1 = client.act({ type: "editText", id, text: "v1" });
    client.act({ type: "editText", id, text: "v2" });
    client.act({ type: "editText", id, text: "v3" });
    if (!e1.ok) throw new Error("editText должен был пройти офлайн");
    const beforeReject = client.inspect().pending;
    const e1Dot = beforeReject[1]?.dot;
    const e2DotOriginal = beforeReject[2]?.dot;
    const e3DotOriginal = beforeReject[3]?.dot;
    if (!e1Dot || !e2DotOriginal || !e3DotOriginal) {
      throw new Error("ожидали create + три правки в P");
    }

    expect(client.inspect().status).toBe("offline");
    const sent = client.receive(rejectMessage(e1Dot, "forbidden"));

    expect(sent).toEqual([]);
    const pending = client.inspect().pending;
    // create + две пересобранные правки.
    expect(pending).toHaveLength(3);
    // Пересобраны по-настоящему — новые dot, не старые e2Dot/e3Dot.
    expect(pending[1]?.dot).not.toEqual(e2DotOriginal);
    expect(pending[2]?.dot).not.toEqual(e3DotOriginal);
    expect(textValueOf(pending[1])).toBe("v2");
    expect(textValueOf(pending[2])).toBe("v3");
  });
});

describe("REQ-024 кр.3 — независимая дельта между зависимыми не пересобирается", () => {
  it("REQ-024 кр.3: setColor другого стикера между двумя правками текста остаётся на месте — тот же dot, та же дельта", () => {
    const { client, ports } = welcomedClient();

    const created1 = client.act(stickerIntent("s1", "стикер 1"));
    const created2 = client.act(stickerIntent("s2", "стикер 2"));
    if (!created1.ok || !created2.ok) throw new Error("createSticker должен был пройти");
    client.receive(ackMessage(operationDot(parseOp(created1.send[0] as string).delta), 1));
    client.receive(ackMessage(operationDot(parseOp(created2.send[0] as string).delta), 2));

    const view = client.inspect().view;
    const start = view.columns.get("start") ?? [];
    const id1 = start.find((item) => "text" in item && item.text.includes("стикер 1"))?.id;
    const id2 = start.find((item) => "text" in item && item.text.includes("стикер 2"))?.id;
    if (!id1 || !id2) throw new Error("ожидали два стикера в колонке start");

    const e1 = client.act({ type: "editText", id: id1, text: "v1" });
    const indep = client.act({ type: "setColor", id: id2, color: "green" });
    const e2 = client.act({ type: "editText", id: id1, text: "v2" });
    const e3 = client.act({ type: "editText", id: id1, text: "v3" });
    if (!e1.ok || !indep.ok || !e2.ok || !e3.ok) throw new Error("act должен был пройти");

    const e1Dot = operationDot(parseOp(e1.send[0] as string).delta);
    const e2DotOriginal = operationDot(parseOp(e2.send[0] as string).delta);
    const e3DotOriginal = operationDot(parseOp(e3.send[0] as string).delta);
    const indepEntryBefore = client
      .inspect()
      .pending.find((entry) => entry.intent.type === "setColor");
    if (!indepEntryBefore) throw new Error("ожидали независимую запись setColor в P");

    client.receive(rejectMessage(e1Dot, "forbidden"));

    const snapshot = client.inspect();
    expect(snapshot.pending).toHaveLength(3);

    const indepAfter = snapshot.pending.find((entry) => entry.intent.type === "setColor");
    expect(indepAfter).toEqual(indepEntryBefore);
    // Независимая дельта — теперь первая (после неё в P было только то, что зависело от e1).
    expect(snapshot.pending[0]).toEqual(indepEntryBefore);

    // Пересобранные правки — после неё, в исходном относительном порядке, с новыми dot.
    const reassembledE2 = snapshot.pending[1];
    const reassembledE3 = snapshot.pending[2];
    expect(textValueOf(reassembledE2)).toBe("v2");
    expect(textValueOf(reassembledE3)).toBe("v3");
    expect(reassembledE2?.dot).not.toEqual(e2DotOriginal);
    expect(reassembledE3?.dot).not.toEqual(e3DotOriginal);
    // Пересобранная №3 перекрывает пересобранную №2, а не исходную (не setColor, не старую e2).
    const e3Supersedes = reassembledE3?.delta.supersedes.map((s) => s.dot) ?? [];
    expect(e3Supersedes).toContainEqual(reassembledE2?.dot);
    expect(e3Supersedes).not.toContainEqual(e2DotOriginal);

    expect(ports.outboxStore.read()).toEqual(snapshot.pending);
  });
});

describe("REQ-024 кр.4 — reject создания стикера удаляет каскадом все действия над ним", () => {
  it("REQ-024 кр.4: editText/move/vote над стикером, чьё создание отклонено, удаляются из P целиком (не пересобираются); rejections несёт причину создания и cause у каждого; стикера нет на экране", () => {
    const { client } = welcomedClient();

    const created = client.act(stickerIntent("s", "будет отклонён"));
    if (!created.ok) throw new Error("createSticker должен был пройти");
    const createDot = operationDot(parseOp(created.send[0] as string).delta);
    const id = firstItemId(client.inspect().view, "start");

    const edited = client.act({ type: "editText", id, text: "правка" });
    const moved = client.act({ type: "move", id, place: { column: "stop", frac: "z" } });
    const voted = client.act({ type: "vote", target: id });
    if (!edited.ok || !moved.ok || !voted.ok)
      throw new Error("действия над стикером должны были пройти");

    const editDot = operationDot(parseOp(edited.send[0] as string).delta);
    const moveDot = operationDot(parseOp(moved.send[0] as string).delta);
    const voteDot = operationDot(parseOp(voted.send[0] as string).delta);

    expect(client.inspect().pending).toHaveLength(4);

    const sent = client.receive(rejectMessage(createDot, "forbidden"));

    const snapshot = client.inspect();
    expect(snapshot.pending).toEqual([]);
    expect(snapshot.rejections).toEqual([
      { dot: createDot, reason: "forbidden" },
      { dot: editDot, reason: "forbidden", cause: createDot },
      { dot: moveDot, reason: "forbidden", cause: createDot },
      { dot: voteDot, reason: "forbidden", cause: createDot },
    ]);

    // Нечего пересобирать — все зависимости удалены насовсем (по сущности/голосу, не по перекрытию).
    expect(sent).toEqual([]);

    const start = snapshot.view.columns.get("start") ?? [];
    expect(start.find((item) => item.id === id)).toBeUndefined();

    // Устаревший ответ сервера на одну из удалённых зависимых операций — игнор.
    const stale = client.receive(rejectMessage(editDot, "unknown_target"));
    expect(stale).toEqual([]);
    expect(client.inspect().pending).toEqual([]);
    expect(client.inspect().rejections).toEqual(snapshot.rejections);
  });
});

describe("REQ-024 кр.4 (ADR-0010 п. 1б) — reject голоса каскадом удаляет ожидающий unvote этого голоса", () => {
  it("REQ-024: reject vote с ожидающим unvote того же голоса — unvote удалён каскадом, cause = dot голоса", () => {
    const { client } = welcomedClient();

    const created = client.act(stickerIntent("s", "цель для голосования"));
    if (!created.ok) throw new Error("createSticker должен был пройти");
    const createDot = operationDot(parseOp(created.send[0] as string).delta);
    client.receive(ackMessage(createDot, 1));
    const id = firstItemId(client.inspect().view, "start");

    const voted = client.act({ type: "vote", target: id });
    if (!voted.ok) throw new Error("vote должен был пройти");
    const voteDot = operationDot(parseOp(voted.send[0] as string).delta);

    const unvoted = client.act({ type: "unvote", voteDot, target: id });
    if (!unvoted.ok) throw new Error("unvote должен был пройти");

    expect(client.inspect().pending).toHaveLength(2);

    client.receive(rejectMessage(voteDot, "vote_limit"));

    const snapshot = client.inspect();
    expect(snapshot.pending).toEqual([]);
    expect(snapshot.rejections).toEqual([
      { dot: voteDot, reason: "vote_limit" },
      { dot: voteDot, reason: "vote_limit", cause: voteDot },
    ]);

    const card = snapshot.view.columns.get("start")?.[0] as { votes: number };
    expect(card.votes).toBe(0);
  });
});

describe("REQ-024 — транзитивность пересборки: №3 перекрывает пересобранную №2, а не исходную", () => {
  it("REQ-024: после reject первой правки, пересобранная третья ссылается (supersedes) на dot пересобранной второй, а не на исходный dot второй или первой", () => {
    const { client, e1Dot, e2DotOriginal } = setupEditChain();

    client.receive(rejectMessage(e1Dot, "forbidden"));

    const [reassembledE2, reassembledE3] = client.inspect().pending;
    if (!reassembledE2 || !reassembledE3) {
      throw new Error("ожидали два пересобранных элемента в P");
    }

    const e3Supersedes = reassembledE3.delta.supersedes.map((s) => s.dot);
    expect(e3Supersedes).toContainEqual(reassembledE2.dot);
    expect(e3Supersedes).not.toContainEqual(e1Dot);
    expect(e3Supersedes).not.toContainEqual(e2DotOriginal);
  });
});

describe("REQ-024 кр.3/ADR-0010 п. 5 — устаревшие ответы сервера на пересобранные/удалённые копии игнорируются", () => {
  it("REQ-024: reject на исходный dot второй и третьей правки (сервер их всё равно отклонит по V4) — не меняет P/rejections/X_c, не бросает", () => {
    const { client, e1Dot, e2DotOriginal, e3DotOriginal } = setupEditChain();

    client.receive(rejectMessage(e1Dot, "forbidden"));
    const before = client.inspect();

    const sentForOldE2 = client.receive(rejectMessage(e2DotOriginal, "unjustified_supersede"));
    const sentForOldE3 = client.receive(rejectMessage(e3DotOriginal, "unjustified_supersede"));

    expect(sentForOldE2).toEqual([]);
    expect(sentForOldE3).toEqual([]);

    const after = client.inspect();
    expect(after.pending).toEqual(before.pending);
    expect(after.rejections).toEqual(before.rejections);
    expect(equals(after.confirmed, before.confirmed)).toBe(true);
  });
});

describe("REQ-024 кр.3 — outbox.save после reject содержит итоговый P, включая пересобранные с их intent", () => {
  it("REQ-024: ports.outbox.read() после reject равен client.inspect().pending, у пересобранных элементов сохранён исходный intent, но НЕ исходный dot", () => {
    const { client, ports, id, e1Dot, e2DotOriginal, e3DotOriginal } = setupEditChain();

    client.receive(rejectMessage(e1Dot, "forbidden"));

    const pending = client.inspect().pending;
    expect(ports.outboxStore.read()).toEqual(pending);
    expect(pending.map((entry) => entry.intent)).toEqual([
      { type: "editText", id, text: "v2" },
      { type: "editText", id, text: "v3" },
    ]);
    // Намерение сохранено, но запись действительно пересобрана — dot новый.
    expect(pending[0]?.dot).not.toEqual(e2DotOriginal);
    expect(pending[1]?.dot).not.toEqual(e3DotOriginal);
  });
});

describe("REQ-024 кр.5 — серия act+reject не разгоняет часы Lamport (ADR-0010 п. 4)", () => {
  it("REQ-024 кр.5: 1500 подряд act()+reject() без единой чужой/подтверждённой операции не поднимают метку следующей дельты — она остаётся max(lamport в X_c ⊔ ⨆P) + 1, а не растёт с числом отказов; счётчик dot при этом растёт", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);
    // Существование цели не проверяется client-core (см. JSDoc act()) —
    // достаточно синтаксически валидного EntityId постороннего актора.
    const fakeTarget = `${otherActorId()}:1`;

    const CYCLES = 1500;
    let firstDotCounter = -1;
    let lastDotCounter = -1;
    let firstLamport = -1;
    let lastLamport = -1;

    for (let i = 0; i < CYCLES; i++) {
      const result = client.act({ type: "editText", id: fakeTarget, text: `правка ${i}` });
      if (!result.ok) throw new Error(`act #${i} должен был пройти: ${JSON.stringify(result)}`);

      const entry = client.inspect().pending[0];
      if (!entry) throw new Error("ожидали ровно один элемент в P");
      const lamport = entry.delta.entries.find((e) => e.key.field === "text")?.stamp.lamport;
      if (lamport === undefined) throw new Error("ожидали запись text со Stamp");

      if (i === 0) {
        firstDotCounter = entry.dot.counter;
        firstLamport = lamport;
      }
      if (i === CYCLES - 1) {
        lastDotCounter = entry.dot.counter;
        lastLamport = lamport;
      }

      client.receive(rejectMessage(entry.dot, "forbidden"));
      expect(client.inspect().pending).toEqual([]);
    }

    // Счётчик dot продолжает расти — не переиспользуется (ADR-0010 п. 4).
    expect(lastDotCounter).toBeGreaterThan(firstDotCounter);
    expect(lastDotCounter).toBeGreaterThanOrEqual(CYCLES);

    // X_c и P всё это время оставались пусты (ничего не подтверждалось, ни от
    // кого чужих операций не приходило) — max lamport в X_c ⊔ ⨆P всегда 0,
    // поэтому метка каждой новой попытки остаётся 1, а не растёт с i.
    expect(firstLamport).toBe(1);
    expect(lastLamport).toBe(1);

    // Финальная успешная (не отклонённая) операция подтверждает то же самое.
    const finalResult = client.act({ type: "editText", id: fakeTarget, text: "финальная правка" });
    if (!finalResult.ok) throw new Error("финальный act должен был пройти");
    const finalEntry = client.inspect().pending[0];
    if (!finalEntry) throw new Error("ожидали элемент в P");
    const finalLamport = finalEntry.delta.entries.find((e) => e.key.field === "text")?.stamp
      .lamport;
    expect(finalLamport).toBe(1);
    expect(finalEntry.dot.counter).toBeGreaterThan(lastDotCounter);
  });
});
