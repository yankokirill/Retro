// T-017 § 1 — голосование в контроллере доски поверх настоящего createSyncClient.
// REQ-015 кр. 1, 3, 4, 5.

import { createMemoryOutboxStore, createSyncClient } from "@retro/client-core";
import {
  type CardView,
  createSticker,
  deleteEntity,
  newClock,
  type State,
  toWire,
  vote,
  type WireDelta,
} from "@retro/crdt";
import { type BoardMeta, clientMessageSchema, serverMessageSchema } from "@retro/protocol";
import { describe, expect, it } from "vitest";
import { createBoardController } from "../src/board-controller.js";

const BOARD = "22222222-2222-4222-8222-222222222222";
const ME = "11111111-1111-4111-8111-111111111111";
const ACTOR_X = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACTOR_Y = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MY_TOKEN = "voter-1";
const OTHER_TOKEN = "voter-other";

const META: BoardMeta = {
  boardId: BOARD,
  title: "Ретро",
  phase: "vote",
  revealed: true,
  voteLimit: 3,
  timer: null,
  authors: {},
};

const msg = (m: unknown) => JSON.stringify(serverMessageSchema.parse(m));
const opMsg = (seq: number, delta: WireDelta) => msg({ type: "op", seq, delta });

const EMPTY_STATE: State = {
  created: new Map(),
  entries: new Map(),
  supersedes: new Map(),
  votes: new Map(),
  unvotes: new Map(),
};

const remote = (() => {
  const created = createSticker(EMPTY_STATE, newClock(ACTOR_X), {
    column: "start",
    frac: "a",
    text: "A",
    color: "yellow",
  });
  return {
    state: created.delta as State,
    id: [...created.delta.created.values()][0]?.id as string,
    wire: toWire(created.delta),
  };
})();

function setup(opts: { welcome?: boolean; withSticker?: boolean } = {}) {
  const client = createSyncClient(
    { boardId: BOARD, guestId: "guest-1", displayName: "Аня" },
    { newActorId: () => ME, newCommandId: () => "cmd", outbox: createMemoryOutboxStore() },
  );
  const sent: string[] = [];
  const controller = createBoardController({
    client,
    send: (lines) => {
      sent.push(...lines);
    },
  });
  if (opts.welcome !== false) {
    client.connected();
    client.receive(
      msg({
        type: "welcome",
        role: "participant",
        voterToken: MY_TOKEN,
        meta: META,
        snapshot: null,
        ops: opts.withSticker === false ? [] : [{ seq: 1, delta: remote.wire }],
      }),
    );
    controller.refresh();
  }
  const state = () => controller.store.getState();
  const card = () =>
    (state().view.columns.get("start") ?? []).find((c) => c.id === remote.id) as
      | CardView
      | undefined;
  const lastOp = () => {
    const parsed = clientMessageSchema.parse(JSON.parse(sent[sent.length - 1] as string));
    if (parsed.type !== "op") throw new Error("ожидали op");
    return parsed.delta;
  };
  const receive = (m: string) => {
    client.receive(m);
    controller.refresh();
  };
  return { client, controller, sent, state, card, lastOp, receive };
}

const otherVote = (token: string, actor = ACTOR_Y) =>
  toWire(vote(remote.state, newClock(actor), remote.id, token).delta);

describe("BoardController: голоса", () => {
  it("REQ-015: до welcome votesLeft и voteLimit равны null, myVotes пуст", () => {
    const s = setup({ welcome: false });
    expect(s.state().votesLeft).toBeNull();
    expect(s.state().voteLimit).toBeNull();
    expect(s.state().myVotes).toEqual({});
  });

  it("REQ-015: после welcome voteLimit из meta, votesLeft = лимит", () => {
    const s = setup();
    expect(s.state().voteLimit).toBe(3);
    expect(s.state().votesLeft).toBe(3);
  });

  it("REQ-015: кр. 1 — vote увеличивает голоса у цели на 1 и уменьшает votesLeft на 1", () => {
    const s = setup();
    expect(s.card()?.votes).toBe(0);
    expect(s.controller.vote(remote.id)).toMatchObject({ ok: true });
    expect(s.sent).toHaveLength(1);
    expect(s.card()?.votes).toBe(1);
    expect(s.state().myVotes[remote.id]).toBe(1);
    expect(s.state().votesLeft).toBe(2);
    const delta = s.lastOp();
    expect(delta.votes).toHaveLength(1);
    expect(delta.votes[0]?.target).toBe(remote.id);
    expect(delta.votes[0]?.user).toBe(MY_TOKEN);
  });

  it("REQ-015: кр. 3 — несколько голосов одной цели разрешены, расходуют лимит по одному", () => {
    const s = setup();
    s.controller.vote(remote.id);
    s.controller.vote(remote.id);
    expect(s.card()?.votes).toBe(2);
    expect(s.state().myVotes[remote.id]).toBe(2);
    expect(s.state().votesLeft).toBe(1);
    expect(s.sent).toHaveLength(2);
  });

  it("REQ-015: vote не проверяет остаток локально — истину знает сервер", () => {
    const s = setup();
    for (let i = 0; i < 4; i++) expect(s.controller.vote(remote.id).ok).toBe(true);
    expect(s.sent).toHaveLength(4);
    expect(s.state().votesLeft).toBe(0);
  });

  it("REQ-015: кр. 4 — unvote отзывает один голос и возвращает votesLeft", () => {
    const s = setup();
    s.controller.vote(remote.id);
    s.controller.vote(remote.id);
    expect(s.controller.unvote(remote.id)).toMatchObject({ ok: true });
    expect(s.card()?.votes).toBe(1);
    expect(s.state().myVotes[remote.id]).toBe(1);
    expect(s.state().votesLeft).toBe(2);
    const delta = s.lastOp();
    expect(delta.unvotes).toHaveLength(1);
    expect(delta.unvotes[0]?.target).toBe(remote.id);
  });

  it("REQ-015: unvote без своих голосов — invalid_intent, ничего не отправляется", () => {
    const s = setup();
    expect(s.controller.unvote(remote.id)).toEqual({ ok: false, reason: "invalid_intent" });
    expect(s.sent).toHaveLength(0);
    expect(s.client.inspect().pending).toHaveLength(0);
  });

  it("REQ-015: unvote не отзывает чужой голос — у цели есть только чужие голоса", () => {
    const s = setup();
    s.receive(opMsg(2, otherVote(OTHER_TOKEN)));
    expect(s.card()?.votes).toBe(1);
    expect(s.controller.unvote(remote.id)).toEqual({ ok: false, reason: "invalid_intent" });
    expect(s.sent).toHaveLength(0);
    expect(s.card()?.votes).toBe(1);
  });

  it("REQ-015: кр. 5 — чужие голоса идут в общий счёт цели, но не в myVotes и votesLeft", () => {
    const s = setup();
    s.receive(opMsg(2, otherVote(OTHER_TOKEN)));
    expect(s.card()?.votes).toBe(1);
    expect(s.state().myVotes[remote.id] ?? 0).toBe(0);
    expect(s.state().votesLeft).toBe(3);

    s.controller.vote(remote.id);
    expect(s.card()?.votes).toBe(2);
    expect(s.state().myVotes[remote.id]).toBe(1);
    expect(s.state().votesLeft).toBe(2);
  });

  it("REQ-015: голос с моим токеном из другой вкладки (op от другого актора) считается моим", () => {
    const s = setup();
    s.receive(opMsg(2, otherVote(MY_TOKEN)));
    expect(s.card()?.votes).toBe(1);
    expect(s.state().myVotes[remote.id]).toBe(1);
    expect(s.state().votesLeft).toBe(2);
  });

  it("REQ-015: голос за удалённый стикер остаётся в счёте лимита", () => {
    const s = setup();
    s.controller.vote(remote.id);
    expect(s.state().votesLeft).toBe(2);
    const del = toWire(deleteEntity(remote.state, newClock(ACTOR_Y), remote.id).delta);
    s.receive(opMsg(2, del));
    expect(s.card()).toBeUndefined();
    expect(s.state().myVotes[remote.id]).toBe(1);
    expect(s.state().votesLeft).toBe(2);
  });

  it("REQ-015: reject vote_limit убирает голос, восстанавливает votesLeft и даёт notice", () => {
    const s = setup();
    s.controller.vote(remote.id);
    const dot = s.client.inspect().pending[0]?.dot as { actor: string; counter: number };
    expect(s.state().votesLeft).toBe(2);
    s.receive(msg({ type: "reject", dot, reason: "vote_limit", message: "лимит" }));
    expect(s.card()?.votes).toBe(0);
    expect(s.state().myVotes[remote.id] ?? 0).toBe(0);
    expect(s.state().votesLeft).toBe(3);
    const { notices } = s.state();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text.trim().length).toBeGreaterThan(0);
  });

  it("REQ-015: unvote выбирает голос с наибольшим счётчиком dot", () => {
    const s = setup();
    s.controller.vote(remote.id);
    s.controller.vote(remote.id);
    s.controller.vote(remote.id);
    const dots = s.sent
      .map((line) => clientMessageSchema.parse(JSON.parse(line)))
      .flatMap((m) => (m.type === "op" ? m.delta.votes.map((v) => v.dot) : []));
    expect(dots).toHaveLength(3);
    const maxCounter = Math.max(...dots.map((d) => d.counter));
    s.controller.unvote(remote.id);
    const un = s.lastOp().unvotes[0];
    expect(un?.dot.counter).toBe(maxCounter);
    expect(un?.dot.actor).toBe(ME);

    s.controller.unvote(remote.id);
    const second = s.lastOp().unvotes[0];
    expect(second?.dot.counter).toBe(
      Math.max(...dots.map((d) => d.counter).filter((c) => c < maxCounter)),
    );
  });
});
