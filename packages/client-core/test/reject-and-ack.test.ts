// T-028 — REQ-024 «Отклонённая операция не оставляет участника в рассинхроне»
// (кр. 1 — кр. 2 про текст причины относится к UI, не к этому пакету) и
// гипотеза H3 (`docs/spec/simulator.md` § 12, `docs/design/T-005-simulator.md`
// § 4): `ack`/`reject` сопоставляются с ПЕРВОЙ по порядку добавления
// дельтой `P` с данным dot — важно для пары vote/unvote с общим dot.
//
// `createSyncClient` — заглушка; каждый тест ниже должен падать на
// `Error: createSyncClient: not implemented`.

import { equals } from "@retro/crdt";
import { operationDot } from "@retro/protocol";
import { describe, expect, it } from "vitest";
import { createSyncClient } from "../src/client.js";
import type { Intent } from "../src/types.js";
import { firstItemId, makeConfig, makePorts, parseOp, welcomeMessage } from "./fixtures.js";

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

describe("REQ-024 кр.1 — reject убирает с экрана только свою операцию", () => {
  it("REQ-024 кр.1: reject удаляет из P только дельту с этим dot, остальные ожидающие дельты не трогает", () => {
    const { client, ports } = welcomedClient();

    const a = client.act(stickerIntent("a", "стикер A"));
    const b = client.act(stickerIntent("b", "стикер B"));
    if (!a.ok || !b.ok) throw new Error("оба act() должны были пройти");

    const dotA = operationDot(parseOp(a.send[0] as string).delta);
    const dotB = operationDot(parseOp(b.send[0] as string).delta);

    client.receive(
      JSON.stringify({ type: "reject", dot: dotA, reason: "forbidden", message: "нельзя" }),
    );

    const snapshot = client.inspect();
    expect(snapshot.pending).toHaveLength(1);
    expect(snapshot.pending[0]?.dot).toEqual(dotB);
    expect(snapshot.rejections).toEqual([{ dot: dotA, reason: "forbidden" }]);
    expect(ports.outboxStore.read()).toEqual(snapshot.pending);
  });

  it("REQ-024 кр.1: экран после reject — как будто отклонённой операции не было; остальные оптимистичные правки остаются", () => {
    const { client } = welcomedClient();

    const a = client.act(stickerIntent("a", "останется"));
    const b = client.act(stickerIntent("b", "отклонят"));
    if (!a.ok || !b.ok) throw new Error("оба act() должны были пройти");
    const dotB = operationDot(parseOp(b.send[0] as string).delta);

    expect(client.inspect().view.columns.get("start")).toHaveLength(2);

    client.receive(
      JSON.stringify({ type: "reject", dot: dotB, reason: "wrong_phase", message: "не та фаза" }),
    );

    const view = client.inspect().view;
    const start = view.columns.get("start") ?? [];
    expect(start).toHaveLength(1);
    const remaining = start[0];
    if (!remaining || !("text" in remaining)) throw new Error("ожидали CardView");
    expect(remaining.text).toEqual(["останется"]);
  });

  it("REQ-024 кр.1: reject своей pending-операции не меняет подтверждённое состояние X_c (чужая, уже принятая правка остаётся)", () => {
    const { client } = welcomedClient();

    // Подтверждаем один собственный стикер (через ack), чтобы он попал в X_c.
    const confirmed = client.act(stickerIntent("z", "уже подтверждено"));
    if (!confirmed.ok) throw new Error("act должен был пройти");
    const confirmedDot = operationDot(parseOp(confirmed.send[0] as string).delta);
    client.receive(JSON.stringify({ type: "ack", dot: confirmedDot, seq: 1 }));

    const confirmedStateBefore = client.inspect().confirmed;

    // Ещё одна операция остаётся в P и будет отклонена.
    const rejected = client.act(stickerIntent("y", "будет отклонено"));
    if (!rejected.ok) throw new Error("act должен был пройти");
    const rejectedDot = operationDot(parseOp(rejected.send[0] as string).delta);

    client.receive(
      JSON.stringify({ type: "reject", dot: rejectedDot, reason: "invalid_shape", message: "x" }),
    );

    expect(equals(client.inspect().confirmed, confirmedStateBefore)).toBe(true);
  });

  it("REQ-024 кр.1: rejections не усекается — несколько отказов подряд накапливаются в порядке получения", () => {
    const { client } = welcomedClient();

    const a = client.act(stickerIntent("a", "первый"));
    const b = client.act(stickerIntent("b", "второй"));
    if (!a.ok || !b.ok) throw new Error("act должен был пройти");
    const dotA = operationDot(parseOp(a.send[0] as string).delta);
    const dotB = operationDot(parseOp(b.send[0] as string).delta);

    client.receive(
      JSON.stringify({ type: "reject", dot: dotA, reason: "forbidden", message: "1" }),
    );
    client.receive(
      JSON.stringify({ type: "reject", dot: dotB, reason: "vote_limit", message: "2" }),
    );

    expect(client.inspect().rejections).toEqual([
      { dot: dotA, reason: "forbidden" },
      { dot: dotB, reason: "vote_limit" },
    ]);
  });
});

describe("H3 (simulator.md § 12) — vote и его unvote делят один dot; ack/reject матчатся по FIFO, не по последнему", () => {
  it("H3: первый ack(dot) для пары vote/unvote с общим dot переносит в X_c ИМЕННО vote (первый добавленный), не unvote", () => {
    const { client } = welcomedClient();

    const created = client.act(stickerIntent("s", "цель для голосования"));
    if (!created.ok) throw new Error("act должен был пройти");
    const createdDot = operationDot(parseOp(created.send[0] as string).delta);
    client.receive(JSON.stringify({ type: "ack", dot: createdDot, seq: 1 }));

    const id = firstItemId(client.inspect().view, "start");

    const voted = client.act({ type: "vote", target: id });
    if (!voted.ok) throw new Error("vote должен был пройти");
    const voteDot = operationDot(parseOp(voted.send[0] as string).delta);

    const unvoted = client.act({ type: "unvote", voteDot, target: id });
    if (!unvoted.ok) throw new Error("unvote должен был пройти");

    // P сейчас: [ {dot: voteDot, kind: op}, {dot: voteDot, kind: unvote} ] — оба с одним dot.
    expect(client.inspect().pending).toHaveLength(2);
    expect(client.inspect().pending.map((entry) => entry.dot)).toEqual([voteDot, voteDot]);

    client.receive(JSON.stringify({ type: "ack", dot: voteDot, seq: 2 }));

    const afterFirstAck = client.inspect();
    // Ушёл ПЕРВЫЙ элемент (vote) — остался только unvote.
    expect(afterFirstAck.pending).toHaveLength(1);
    expect(afterFirstAck.pending[0]?.kind).toBe("unvote");

    // Экран не менялся: голос был отозван локально до всякого ack, поэтому
    // объединённое X_c ⊔ ⨆P всё это время не учитывало его в votes.
    const cardDuringGap = afterFirstAck.view.columns.get("start")?.[0] as { votes: number };
    expect(cardDuringGap.votes).toBe(0);

    client.receive(JSON.stringify({ type: "ack", dot: voteDot, seq: 3 }));

    const afterSecondAck = client.inspect();
    expect(afterSecondAck.pending).toHaveLength(0);
    const cardAfter = afterSecondAck.view.columns.get("start")?.[0] as { votes: number };
    expect(cardAfter.votes).toBe(0);
  });

  it("H3: reject(dot) на паре vote/unvote с общим dot убирает ПЕРВЫЙ элемент (vote), второй ack на тот же dot после этого матчит unvote, без исключений", () => {
    const { client } = welcomedClient();

    const created = client.act(stickerIntent("s", "цель для голосования"));
    if (!created.ok) throw new Error("act должен был пройти");
    const createdDot = operationDot(parseOp(created.send[0] as string).delta);
    client.receive(JSON.stringify({ type: "ack", dot: createdDot, seq: 1 }));
    const id = firstItemId(client.inspect().view, "start");

    const voted = client.act({ type: "vote", target: id });
    if (!voted.ok) throw new Error("vote должен был пройти");
    const voteDot = operationDot(parseOp(voted.send[0] as string).delta);
    const unvoted = client.act({ type: "unvote", voteDot, target: id });
    if (!unvoted.ok) throw new Error("unvote должен был пройти");

    client.receive(
      JSON.stringify({ type: "reject", dot: voteDot, reason: "vote_limit", message: "лимит" }),
    );

    const afterReject = client.inspect();
    expect(afterReject.pending).toHaveLength(1);
    expect(afterReject.pending[0]?.kind).toBe("unvote");
    expect(afterReject.rejections).toEqual([{ dot: voteDot, reason: "vote_limit" }]);

    // Второй ответ сервера на тот же dot (теперь это ack на unvote, ADR-0008) —
    // матчит оставшийся элемент, не бросает исключение.
    expect(() =>
      client.receive(JSON.stringify({ type: "ack", dot: voteDot, seq: 5 })),
    ).not.toThrow();
    expect(client.inspect().pending).toHaveLength(0);
  });
});
