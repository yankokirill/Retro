// T-028 — REQ-023 «Работа при временной потере сети» (кр. 1–3) и связанный
// контракт `act()`/`connected()` из JSDoc `../src/types.ts`.
//
// `createSyncClient` сейчас — заглушка (`throw new Error("createSyncClient:
// not implemented")`, `../src/client.ts`), поэтому каждый тест ниже должен
// падать именно на этой ошибке — не на неверном импорте и не на невалидном
// по `serverMessageSchema` сообщении (фикстуры в `./fixtures.ts` это
// гарантируют).

import { createSticker, empty, equals, newClock } from "@retro/crdt";
import { operationDot } from "@retro/protocol";
import { describe, expect, it } from "vitest";
import { createSyncClient } from "../src/client.js";
import type { Intent } from "../src/types.js";
import {
  firstItemId,
  makeConfig,
  makePorts,
  otherActorId,
  parseHello,
  parseOp,
  welcomeMessage,
  wireOf,
} from "./fixtures.js";

const createIntent = (frac = "m"): Intent => ({
  type: "createSticker",
  column: "start",
  frac,
  text: "первая мысль",
  color: "yellow",
});

describe("REQ-023 кр.1 — офлайн-действия применяются локально и складываются в очередь", () => {
  it("REQ-023 кр.1: act() до всякого connected() (status = offline) — ok:true, дельта в P, send = []", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);

    expect(client.inspect().status).toBe("offline");

    const result = client.act(createIntent());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.send).toEqual([]);

    const snapshot = client.inspect();
    expect(snapshot.pending).toHaveLength(1);
    expect(snapshot.pending[0]?.kind).toBe("op");
  });

  it("REQ-023 кр.1: стикер, созданный офлайн, сразу виден в inspect().view (materialize(X_c ⊔ ⨆P))", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);

    client.act(createIntent());

    const view = client.inspect().view;
    const startColumn = view.columns.get("start") ?? [];
    expect(startColumn).toHaveLength(1);
    const card = startColumn[0];
    if (!card || !("text" in card)) throw new Error("ожидали CardView в колонке start");
    expect(card.text).toEqual(["первая мысль"]);
  });

  it("REQ-023 кр.1: act() применяется локально и в статусе connecting (после connected(), до welcome)", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);

    client.connected();
    expect(client.inspect().status).toBe("connecting");

    const result = client.act(createIntent());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // Клиент ещё не welcomed — дельта осталась в очереди, ничего не отправляется сейчас.
    expect(result.send).toEqual([]);
    expect(client.inspect().pending).toHaveLength(1);
  });

  it("REQ-023 кр.1: несколько разных офлайн-действий подряд — все попадают в P независимо от status", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);

    const created = client.act(createIntent("a"));
    if (!created.ok) throw new Error("createSticker должен был примениться офлайн");

    // move — тоже write-операция, не требует welcome/voterToken.
    const id = firstItemId(client.inspect().view, "start");

    const moved = client.act({ type: "move", id, place: { column: "stop", frac: "z" } });
    expect(moved.ok).toBe(true);

    const snapshot = client.inspect();
    expect(snapshot.pending).toHaveLength(2);
    const view2 = snapshot.view;
    expect(view2.columns.get("start")).toEqual([]);
    expect(view2.columns.get("stop")).toHaveLength(1);
  });

  it("REQ-023 кр.1: vote/unvote ДО первого welcome отклоняются с not_welcomed_yet, состояние не меняется", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);

    const before = client.inspect();
    const foreignTarget = `${otherActorId()}:1`;

    const voteResult = client.act({ type: "vote", target: foreignTarget });
    expect(voteResult).toEqual({ ok: false, reason: "not_welcomed_yet" });

    const unvoteResult = client.act({
      type: "unvote",
      voteDot: { actor: otherActorId(), counter: 1 },
      target: foreignTarget,
    });
    expect(unvoteResult).toEqual({ ok: false, reason: "not_welcomed_yet" });

    const after = client.inspect();
    expect(after.pending).toEqual(before.pending);
    expect(equals(after.confirmed, before.confirmed)).toBe(true);
    expect(ports.outboxStore.read()).toEqual([]);
  });

  it("REQ-023 кр.1: vote офлайн РАЗРЕШЁН, если voterToken уже получен из более раннего welcome", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);

    client.connected();
    client.receive(welcomeMessage({ voterToken: "voter-xyz" }));
    expect(client.inspect().status).toBe("welcomed");

    client.disconnected();
    expect(client.inspect().status).toBe("offline");
    expect(client.inspect().voterToken).toBe("voter-xyz");

    const created = client.act(createIntent());
    if (!created.ok) throw new Error("создание должно было пройти");
    const id = firstItemId(client.inspect().view, "start");

    const voteResult = client.act({ type: "vote", target: id });
    expect(voteResult.ok).toBe(true);
    if (!voteResult.ok) throw new Error("unreachable");
    // Клиент офлайн — отправлять некому прямо сейчас.
    expect(voteResult.send).toEqual([]);
    expect(client.inspect().pending).toHaveLength(2);
  });

  it("REQ-023 кр.1: act(ok:true) записывает outbox.save с актуальным содержимым P", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);

    client.act(createIntent());
    expect(ports.outboxStore.read()).toHaveLength(1);

    client.act({
      type: "move",
      id: firstItemId(client.inspect().view, "start"),
      place: { column: "continue", frac: "b" },
    });
    expect(ports.outboxStore.read()).toHaveLength(2);
    expect(ports.outboxStore.read()).toEqual(client.inspect().pending);
  });
});

describe("REQ-023 кр.2 — после восстановления соединения очередь уходит на сервер заново, в исходном порядке", () => {
  it("REQ-023 кр.2: connected() САМА не отправляет P — только hello, даже если P не пуста", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);

    client.act(createIntent());
    const sent = client.connected();

    expect(sent).toHaveLength(1);
    const hello = parseHello(sent[0] as string);
    expect(hello.actorId).toBe(ports.actorId);
  });

  it("REQ-023 кр.2: receive(welcome) отправляет ВСЮ P — по одному op на каждый элемент очереди", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);

    client.act(createIntent("a"));
    const id = firstItemId(client.inspect().view, "start");
    client.act({ type: "move", id, place: { column: "stop", frac: "b" } });

    client.connected();
    const resent = client.receive(welcomeMessage({}));

    expect(resent).toHaveLength(2);
    for (const raw of resent) {
      const op = parseOp(raw);
      expect(op.type).toBe("op");
    }
  });

  it("REQ-023 кр.2: очередь отправляется В ИСХОДНОМ ПОРЯДКЕ добавления (не в обратном, не переставлена)", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);

    // Три создания стикеров с разным текстом — маркер порядка.
    client.act({
      type: "createSticker",
      column: "start",
      frac: "a",
      text: "первый",
      color: "yellow",
    });
    client.act({
      type: "createSticker",
      column: "start",
      frac: "b",
      text: "второй",
      color: "green",
    });
    client.act({
      type: "createSticker",
      column: "start",
      frac: "c",
      text: "третий",
      color: "blue",
    });

    client.connected();
    const resent = client.receive(welcomeMessage({}));

    expect(resent).toHaveLength(3);
    const texts = resent.map((raw) => {
      const op = parseOp(raw);
      const entry = op.delta.entries.find((e) => e.key.field === "text");
      return entry?.value;
    });
    expect(texts).toEqual(["первый", "второй", "третий"]);
  });

  it("REQ-023 кр.2: после welcome статус welcomed и дальнейший act(ok:true) отправляется сразу ([op])", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);

    client.connected();
    client.receive(welcomeMessage({}));
    expect(client.inspect().status).toBe("welcomed");

    const result = client.act(createIntent());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.send).toHaveLength(1);
    parseOp(result.send[0] as string);
  });

  it("REQ-023 кр.2: lastSeq — максимум полученных seq; hello при переподключении несёт именно его", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);

    const foreignState = createSticker(empty(), newClock(otherActorId()), {
      column: "start",
      frac: "a",
      text: "чужой стикер",
      color: "green",
    }).delta;

    client.connected();
    client.receive(welcomeMessage({ ops: [{ seq: 5, delta: wireOf(foreignState) }] }));

    expect(client.inspect().lastSeq).toBe(5);

    client.disconnected();
    const helloRaw = client.connected();
    const hello = parseHello(helloRaw[0] as string);
    expect(hello.lastSeq).toBe(5);
  });
});

describe("REQ-023 кр.3 (клиентская сторона) — повторный ack/reject на dot, которого уже нет в P, игнорируется", () => {
  it("REQ-023 кр.3: повторный ack того же dot после того, как P уже опустела — не бросает, состояние не меняется", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);

    client.connected();
    client.receive(welcomeMessage({}));

    const result = client.act(createIntent());
    if (!result.ok) throw new Error("act должен был пройти");
    const op = parseOp(result.send[0] as string);
    const dot = operationDot(op.delta);

    client.receive(JSON.stringify({ type: "ack", dot, seq: 1 }));
    expect(client.inspect().pending).toEqual([]);

    const before = client.inspect();
    expect(() => client.receive(JSON.stringify({ type: "ack", dot, seq: 1 }))).not.toThrow();
    const after = client.inspect();

    expect(after.pending).toEqual(before.pending);
    expect(equals(after.confirmed, before.confirmed)).toBe(true);
  });

  it("REQ-023 кр.3: ack на dot, которого никогда не было в P — игнорируется, не бросает", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);

    client.connected();
    client.receive(welcomeMessage({}));

    const before = client.inspect();
    const unknownDot = { actor: otherActorId(), counter: 999 };
    expect(() =>
      client.receive(JSON.stringify({ type: "ack", dot: unknownDot, seq: 42 })),
    ).not.toThrow();

    const after = client.inspect();
    expect(after.pending).toEqual(before.pending);
    expect(equals(after.confirmed, before.confirmed)).toBe(true);
  });

  it("REQ-023 кр.3: reject на dot, которого никогда не было в P — игнорируется, не бросает, rejections не растут", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);

    client.connected();
    client.receive(welcomeMessage({}));

    const before = client.inspect();
    const unknownDot = { actor: otherActorId(), counter: 999 };
    expect(() =>
      client.receive(
        JSON.stringify({ type: "reject", dot: unknownDot, reason: "wrong_phase", message: "x" }),
      ),
    ).not.toThrow();

    const after = client.inspect();
    expect(after.pending).toEqual(before.pending);
    expect(after.rejections).toEqual(before.rejections);
  });
});

describe("act(): очередь ограничена (ВС-3) — queue_full при |P| >= maxPending", () => {
  it("act(): третье действие при maxPending=2 отклоняется с queue_full, P не растёт, outbox не переписывается", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig({ maxPending: 2 }), ports);

    const r1 = client.act(createIntent("a"));
    const r2 = client.act(createIntent("b"));
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const savedBefore = ports.outboxStore.read();
    const r3 = client.act(createIntent("c"));

    expect(r3).toEqual({ ok: false, reason: "queue_full" });
    expect(client.inspect().pending).toHaveLength(2);
    expect(ports.outboxStore.read()).toEqual(savedBefore);
  });

  it("act(): queue_full проверяется РАНЬШЕ invalid_intent (порядок проверок из JSDoc act())", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig({ maxPending: 1 }), ports);

    const r1 = client.act(createIntent("a"));
    expect(r1.ok).toBe(true);

    // Эта дельта сама по себе невалидна (текст длиннее лимита), но очередь уже полна —
    // причина отказа должна быть queue_full, а не invalid_intent.
    const tooLong = "ф".repeat(2001);
    const r2 = client.act({
      type: "createSticker",
      column: "start",
      frac: "b",
      text: tooLong,
      color: "yellow",
    });

    expect(r2).toEqual({ ok: false, reason: "queue_full" });
  });
});

describe("act(): invalid_intent — построенная дельта не проходит clientDeltaSchema", () => {
  it("act(): текст стикера длиннее лимита (2000) — invalid_intent, ничего не меняется", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);

    const before = client.inspect();
    const tooLong = "ф".repeat(2001);

    const result = client.act({
      type: "createSticker",
      column: "start",
      frac: "a",
      text: tooLong,
      color: "yellow",
    });

    expect(result).toEqual({ ok: false, reason: "invalid_intent" });

    const after = client.inspect();
    expect(after.pending).toEqual(before.pending);
    expect(equals(after.confirmed, before.confirmed)).toBe(true);
    expect(ports.outboxStore.read()).toEqual([]);
  });

  it("act(): invalid_intent не тратит часы — следующая успешная операция получает dot с counter=1", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);

    const tooLong = "ф".repeat(2001);
    client.act({
      type: "createSticker",
      column: "start",
      frac: "a",
      text: tooLong,
      color: "yellow",
    });

    const ok = client.act(createIntent("b"));
    if (!ok.ok) throw new Error("act должен был пройти после отклонённой попытки");

    const entry = client.inspect().pending[0];
    if (!entry) throw new Error("ожидали один элемент в P");
    expect(entry.dot.counter).toBe(1);
  });
});

describe("act(): голоса и материализация (проверка через activeVotes/materialize, а не внутренние структуры)", () => {
  it("act(): unvote не тратит новый dot — использует dot отзываемого голоса", () => {
    const ports = makePorts();
    const client = createSyncClient(makeConfig(), ports);
    client.connected();
    client.receive(welcomeMessage({}));

    const created = client.act(createIntent());
    if (!created.ok) throw new Error("создание должно было пройти");
    const id = firstItemId(client.inspect().view, "start");

    const voted = client.act({ type: "vote", target: id });
    if (!voted.ok) throw new Error("vote должен был пройти");
    const voteEntry = client.inspect().pending.at(-1);
    if (!voteEntry) throw new Error("ожидали элемент очереди для vote");

    const unvoted = client.act({ type: "unvote", voteDot: voteEntry.dot, target: id });
    if (!unvoted.ok) throw new Error("unvote должен был пройти");
    const unvoteEntry = client.inspect().pending.at(-1);
    if (!unvoteEntry) throw new Error("ожидали элемент очереди для unvote");

    expect(unvoteEntry.kind).toBe("unvote");
    expect(unvoteEntry.dot).toEqual(voteEntry.dot);

    // Голос отозван раньше подтверждения — на экране его быть не должно.
    const card = client.inspect().view.columns.get("start")?.[0] as { votes: number };
    expect(card.votes).toBe(0);
  });
});
