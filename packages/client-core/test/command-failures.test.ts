// T-018 (docs/design/T-018-phases-ui.md § 2): ClientSnapshot.commandFailures.
// Затрагивает REQ-003 кр. 2, REQ-004 кр. 3, REQ-019 кр. 2 — пользователь видит отказ команды.

import { describe, expect, it } from "vitest";
import { createSyncClient } from "../src/client.js";
import { commandResultMessage, makeConfig, makePorts, welcomeMessage } from "./fixtures.js";

function welcomed() {
  const ports = makePorts();
  const client = createSyncClient(makeConfig(), ports);
  client.connected();
  client.receive(welcomeMessage({ role: "facilitator" }));
  return { client, ports };
}

describe("commandFailures", () => {
  it("REQ-004: до любых ответов commandFailures пуст", () => {
    expect(welcomed().client.inspect().commandFailures).toEqual([]);
  });

  it("REQ-004: commandResult ok:true ничего не добавляет", () => {
    const { client } = welcomed();
    client.receive(commandResultMessage("cmd-1", true));
    expect(client.inspect().commandFailures).toEqual([]);
  });

  it("REQ-004: commandResult ok:false добавляет запись с id и reason", () => {
    const { client } = welcomed();
    client.receive(commandResultMessage("cmd-1", false, { reason: "irreversible_phase" }));
    expect(client.inspect().commandFailures).toEqual([
      { id: "cmd-1", reason: "irreversible_phase" },
    ]);
  });

  it("REQ-003: ok:false без reason — invalid_shape", () => {
    const { client } = welcomed();
    client.receive(commandResultMessage("cmd-1", false));
    expect(client.inspect().commandFailures).toEqual([{ id: "cmd-1", reason: "invalid_shape" }]);
  });

  it("REQ-019: отказы идут в порядке получения, по одному на каждое сообщение", () => {
    const { client } = welcomed();
    client.receive(commandResultMessage("a", false, { reason: "wrong_phase" }));
    client.receive(commandResultMessage("b", true));
    client.receive(commandResultMessage("c", false, { reason: "forbidden" }));
    client.receive(commandResultMessage("a", false, { reason: "wrong_phase" }));
    expect(client.inspect().commandFailures).toEqual([
      { id: "a", reason: "wrong_phase" },
      { id: "c", reason: "forbidden" },
      { id: "a", reason: "wrong_phase" },
    ]);
  });

  it("REQ-003: отказы переживают disconnected() и повторный welcome", () => {
    const { client } = welcomed();
    client.receive(commandResultMessage("x", false, { reason: "unknown_target" }));
    client.disconnected();
    expect(client.inspect().commandFailures).toEqual([{ id: "x", reason: "unknown_target" }]);
    client.connected();
    client.receive(welcomeMessage({ role: "facilitator" }));
    expect(client.inspect().commandFailures).toEqual([{ id: "x", reason: "unknown_target" }]);
  });

  it("REQ-004: id отказа совпадает с id отправленной команды", () => {
    const { client, ports } = welcomed();
    const sent = client.command({ type: "setPhase", phase: "collect" });
    expect(sent).toHaveLength(1);
    const id = (JSON.parse(sent[0] as string) as { id: string }).id;
    expect(ports.commandIds()).toContain(id);
    client.receive(commandResultMessage(id, false, { reason: "irreversible_phase" }));
    expect(client.inspect().commandFailures).toEqual([{ id, reason: "irreversible_phase" }]);
  });

  it("REQ-004: commandResult не меняет rejections операций", () => {
    const { client } = welcomed();
    client.receive(commandResultMessage("x", false, { reason: "forbidden" }));
    expect(client.inspect().rejections).toEqual([]);
  });
});
