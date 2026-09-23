// T-018 § 3 — команды метаданных в контроллере доски: setPhase, grantFacilitator,
// startTimer, stopTimer. REQ-003 кр.2, REQ-004 кр.3, REQ-019 кр.2.

import { createMemoryOutboxStore, createSyncClient } from "@retro/client-core";
import { type BoardMeta, clientMessageSchema, serverMessageSchema } from "@retro/protocol";
import { describe, expect, it } from "vitest";
import { createBoardController } from "../src/board-controller.js";
import { describeRejection } from "../src/messages.js";

const BOARD = "22222222-2222-4222-8222-222222222222";
const ME = "11111111-1111-4111-8111-111111111111";
const TARGET = "33333333-3333-4333-8333-333333333333";

const META: BoardMeta = {
  boardId: BOARD,
  title: "Ретро",
  phase: "discuss",
  revealed: true,
  voteLimit: 3,
  timer: null,
  authors: {},
};

const msg = (m: unknown) => JSON.stringify(serverMessageSchema.parse(m));

function setup(opts: { welcome?: boolean } = {}) {
  let n = 0;
  const client = createSyncClient(
    { boardId: BOARD, guestId: "guest-1", displayName: "Аня" },
    {
      newActorId: () => ME,
      newCommandId: () => `cmd-${++n}`,
      outbox: createMemoryOutboxStore(),
    },
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
        role: "owner",
        voterToken: "v",
        meta: META,
        snapshot: null,
        ops: [],
      }),
    );
    controller.refresh();
  }
  const lastCommand = () => {
    const parsed = clientMessageSchema.parse(JSON.parse(sent[sent.length - 1] as string));
    if (parsed.type !== "command") throw new Error("ожидали command");
    return parsed;
  };
  const fail = (id: string, reason?: string) => {
    client.receive(msg({ type: "commandResult", id, ok: false, ...(reason ? { reason } : {}) }));
    controller.refresh();
  };
  return { client, controller, sent, lastCommand, fail };
}

describe("BoardController: команды метаданных", () => {
  it("REQ-004: setPhase отправляет command setPhase и возвращает true", () => {
    const s = setup();
    expect(s.controller.setPhase("vote")).toBe(true);
    expect(s.sent).toHaveLength(1);
    expect(s.lastCommand().command).toEqual({ type: "setPhase", phase: "vote" });
  });

  it("REQ-003: grantFacilitator отправляет command с guestId цели", () => {
    const s = setup();
    expect(s.controller.grantFacilitator(TARGET)).toBe(true);
    expect(s.lastCommand().command).toEqual({ type: "grantFacilitator", guestId: TARGET });
  });

  it("REQ-019: startTimer отправляет command startTimer с секундами", () => {
    const s = setup();
    expect(s.controller.startTimer(300)).toBe(true);
    expect(s.lastCommand().command).toEqual({ type: "startTimer", seconds: 300 });
  });

  it("REQ-019: stopTimer отправляет command stopTimer", () => {
    const s = setup();
    expect(s.controller.stopTimer()).toBe(true);
    expect(s.lastCommand().command).toEqual({ type: "stopTimer" });
  });

  it("REQ-004: не в welcomed все команды возвращают false и ничего не отправляют", () => {
    const s = setup({ welcome: false });
    expect(s.controller.setPhase("vote")).toBe(false);
    expect(s.controller.grantFacilitator(TARGET)).toBe(false);
    expect(s.controller.startTimer(60)).toBe(false);
    expect(s.controller.stopTimer()).toBe(false);
    expect(s.sent).toHaveLength(0);
  });

  it("REQ-004: отказ commandResult становится notice с текстом describeRejection", () => {
    const s = setup();
    s.controller.setPhase("collect");
    const id = s.lastCommand().id;
    s.fail(id, "irreversible_phase");
    const { notices } = s.controller.store.getState();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain(describeRejection("irreversible_phase"));
  });

  it("REQ-003: отказ без reason — notice с текстом для invalid_shape", () => {
    const s = setup();
    s.controller.grantFacilitator(TARGET);
    s.fail(s.lastCommand().id);
    const { notices } = s.controller.store.getState();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain(describeRejection("invalid_shape"));
  });

  it("REQ-019: повторные refresh не дублируют notice, новый отказ добавляет ещё один", () => {
    const s = setup();
    s.controller.startTimer(60);
    s.fail(s.lastCommand().id, "wrong_phase");
    s.controller.refresh();
    s.controller.refresh();
    expect(s.controller.store.getState().notices).toHaveLength(1);

    s.controller.stopTimer();
    s.fail(s.lastCommand().id, "forbidden");
    expect(s.controller.store.getState().notices).toHaveLength(2);
  });

  it("REQ-004: успешный commandResult notice не создаёт", () => {
    const s = setup();
    s.controller.setPhase("vote");
    s.client.receive(msg({ type: "commandResult", id: s.lastCommand().id, ok: true }));
    s.controller.refresh();
    expect(s.controller.store.getState().notices).toHaveLength(0);
  });
});
