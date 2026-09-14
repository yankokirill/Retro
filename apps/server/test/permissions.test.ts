// T-011 — «Права и фазы (V6)»: приёмочные тесты для контракта
// `apps/server/src/ops/permissions.ts` (`classifyAction`, `checkPermission`),
// написанные ДО реализации и не глядя в неё
// (docs/spec/requirements.md REQ-004 кр.2,4; REQ-005 кр.2; REQ-007 кр.3;
// REQ-009; REQ-011; REQ-017; docs/security/permissions.md — источник истины
// для матрицы роль×фаза×действие×владение в этом файле;
// docs/spec/protocol.md § 5 — таблица reason).
//
// Обе функции — заглушки (`Error: classifyAction: not implemented` /
// `Error: checkPermission: not implemented`, см. задачу T-011): каждый
// сценарий ниже должен падать именно из-за этого, а не из-за ошибки в
// самом тесте.
//
// Дельты для classifyAction собираются ТОЛЬКО через публичный API
// `@retro/crdt` (`empty`, `newClock`, `createSticker`, `createAction`,
// `createGroup`, `setColor`, `setGroup`, `setField`, `vote`, `unvote`,
// `toWire`, `dotKey`). Unit-тест, без Testcontainers — обе функции чистые
// (без I/O). `apps/*/src` (кроме контракта `permissions.ts`, данного
// verbatim в задаче T-011) и внутренности `packages/crdt/src/ops/**` не
// читались.
//
// Область теста (docs/security/permissions.md § «Сознательно не в T-011»):
// НЕ проверяются здесь — создание/переименование группы, assignee/done/
// удаление action item, vote/unvote (лимит голосов — T-012/V7),
// resetVotes/timer/grantFacilitator (нет WS-канала), удаление доски,
// видимость до reveal (T-013). setPhase-специфичные правила
// (необратимость collect и т.п.) — это `boardsService.setPhase`, отдельная
// функция от `checkPermission`, не тестируется здесь (см. ws.int.test.ts).

import type { EntityId, State } from "@retro/crdt";
import {
  createAction,
  createGroup,
  createSticker,
  dotKey,
  empty,
  merge,
  newClock,
  setColor,
  setField,
  setGroup,
  toWire,
  unvote,
  vote,
} from "@retro/crdt";
import type { Phase, Role } from "@retro/protocol";
import { describe, expect, it } from "vitest";
import {
  type CheckPermissionResult,
  checkPermission,
  classifyAction,
  type StickerAction,
} from "../src/ops/permissions.js";

const newActor = () => crypto.randomUUID();

const ALL_PHASES: readonly Phase[] = ["collect", "group", "vote", "discuss", "actions"];
const ALL_ACTIONS: readonly StickerAction[] = [
  "createSticker",
  "createAction",
  "editSticker",
  "assignGroup",
];

function otherPhases(allowed: readonly Phase[]): Phase[] {
  return ALL_PHASES.filter((phase) => !allowed.includes(phase));
}

function expectAllowed(result: CheckPermissionResult) {
  expect(result.ok).toBe(true);
}

function expectDenied(
  result: CheckPermissionResult,
  reason: Extract<CheckPermissionResult, { ok: false }>["reason"],
) {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe(reason);
  expect(result.message.length).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// owner / facilitator — полные права всегда (docs/security/permissions.md § Роли)
// ---------------------------------------------------------------------------

describe("REQ-005/REQ-007/REQ-009/REQ-011/REQ-017: owner и facilitator — полные права", () => {
  it.each<Role>(["owner", "facilitator"])(
    "%s: ok:true для любого action × любой фазы × любого isOwn",
    (role) => {
      for (const phase of ALL_PHASES) {
        for (const action of ALL_ACTIONS) {
          for (const isOwn of [true, false]) {
            expectAllowed(checkPermission({ role, phase, action, isOwn }));
          }
        }
      }
    },
  );
});

// ---------------------------------------------------------------------------
// viewer — только чтение, forbidden для любого действия в любой фазе
// ---------------------------------------------------------------------------

describe("REQ-005/REQ-007/REQ-009/REQ-011/REQ-017: viewer — forbidden всегда", () => {
  it("REQ-005: viewer не может создать стикер ни в одной фазе", () => {
    for (const phase of ALL_PHASES) {
      expectDenied(
        checkPermission({ role: "viewer", phase, action: "createSticker", isOwn: false }),
        "forbidden",
      );
    }
  });

  it("REQ-017: viewer не может создать action item ни в одной фазе", () => {
    for (const phase of ALL_PHASES) {
      expectDenied(
        checkPermission({ role: "viewer", phase, action: "createAction", isOwn: false }),
        "forbidden",
      );
    }
  });

  it("REQ-007/REQ-009: viewer не может редактировать стикер ни в одной фазе, даже свой", () => {
    for (const phase of ALL_PHASES) {
      for (const isOwn of [true, false]) {
        expectDenied(
          checkPermission({ role: "viewer", phase, action: "editSticker", isOwn }),
          "forbidden",
        );
      }
    }
  });

  it("REQ-011: viewer не может назначить группу стикеру ни в одной фазе", () => {
    for (const phase of ALL_PHASES) {
      expectDenied(
        checkPermission({ role: "viewer", phase, action: "assignGroup", isOwn: false }),
        "forbidden",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// participant — createSticker: только collect/group (REQ-005)
// ---------------------------------------------------------------------------

describe("REQ-005: participant — создание стикера ограничено фазой", () => {
  it("REQ-005 кр.1: participant может создать стикер в фазах collect и group", () => {
    for (const phase of ["collect", "group"] as const) {
      expectAllowed(
        checkPermission({ role: "participant", phase, action: "createSticker", isOwn: false }),
      );
    }
  });

  it("REQ-005 кр.2: participant не может создать стикер вне collect/group (например, в vote) — wrong_phase", () => {
    for (const phase of otherPhases(["collect", "group"])) {
      expectDenied(
        checkPermission({ role: "participant", phase, action: "createSticker", isOwn: false }),
        "wrong_phase",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// participant — createAction: только discuss/actions (REQ-017)
// ---------------------------------------------------------------------------

describe("REQ-017: participant — создание action item ограничено фазой", () => {
  it("REQ-017 кр.1: participant может создать action item в фазах discuss и actions", () => {
    for (const phase of ["discuss", "actions"] as const) {
      expectAllowed(
        checkPermission({ role: "participant", phase, action: "createAction", isOwn: false }),
      );
    }
  });

  it("REQ-017: participant не может создать action item вне discuss/actions — wrong_phase", () => {
    for (const phase of otherPhases(["discuss", "actions"])) {
      expectDenied(
        checkPermission({ role: "participant", phase, action: "createAction", isOwn: false }),
        "wrong_phase",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// participant — editSticker: фаза collect/group И владение (REQ-007, REQ-009)
// ---------------------------------------------------------------------------

describe("REQ-007/REQ-009: participant — редактирование стикера ограничено фазой и владением", () => {
  it("REQ-007 кр.2/REQ-009: participant может редактировать свой стикер в collect/group", () => {
    for (const phase of ["collect", "group"] as const) {
      expectAllowed(
        checkPermission({ role: "participant", phase, action: "editSticker", isOwn: true }),
      );
    }
  });

  it("REQ-007 кр.3: participant не может редактировать чужой стикер, даже в collect/group — forbidden", () => {
    for (const phase of ["collect", "group"] as const) {
      expectDenied(
        checkPermission({ role: "participant", phase, action: "editSticker", isOwn: false }),
        "forbidden",
      );
    }
  });

  it("REQ-009: participant не может редактировать свой стикер вне collect/group — wrong_phase", () => {
    for (const phase of otherPhases(["collect", "group"])) {
      expectDenied(
        checkPermission({ role: "participant", phase, action: "editSticker", isOwn: true }),
        "wrong_phase",
      );
    }
  });

  it("REQ-009: фаза проверяется раньше владения — чужой стикер вне collect/group тоже wrong_phase, не forbidden", () => {
    for (const phase of otherPhases(["collect", "group"])) {
      expectDenied(
        checkPermission({ role: "participant", phase, action: "editSticker", isOwn: false }),
        "wrong_phase",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// participant — assignGroup: только фаза group, владение НЕ требуется (REQ-011)
// ---------------------------------------------------------------------------

describe("REQ-011: participant — назначение группы ограничено фазой, но не владением", () => {
  it("REQ-011 кр.1: participant может назначить группу стикеру в фазе group независимо от владения", () => {
    for (const isOwn of [true, false]) {
      expectAllowed(
        checkPermission({ role: "participant", phase: "group", action: "assignGroup", isOwn }),
      );
    }
  });

  it("REQ-011: participant не может назначить группу вне фазы group — wrong_phase", () => {
    for (const phase of otherPhases(["group"])) {
      for (const isOwn of [true, false]) {
        expectDenied(
          checkPermission({ role: "participant", phase, action: "assignGroup", isOwn }),
          "wrong_phase",
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// classifyAction — какое действие несёт дельта (docs/security/permissions.md § Реализация)
// ---------------------------------------------------------------------------

describe("classifyAction: распознаёт действие по дельте", () => {
  it("REQ-005: createSticker(...) классифицируется как createSticker", () => {
    const actor = newActor();
    const created = createSticker(empty(), newClock(actor), {
      column: "start",
      frac: "m",
      text: "hello",
      color: "yellow",
    });
    expect(classifyAction(empty(), toWire(created.delta))).toBe("createSticker");
  });

  it("REQ-017: createAction(...) классифицируется как createAction", () => {
    const actor = newActor();
    const created = createAction(empty(), newClock(actor), { text: "do the thing" });
    expect(classifyAction(empty(), toWire(created.delta))).toBe("createAction");
  });

  it("createGroup(...) классифицируется как null — группы не гейтятся в T-011", () => {
    const actor = newActor();
    const created = createGroup(empty(), newClock(actor), {
      column: "start",
      frac: "m",
      title: "Group A",
    });
    expect(classifyAction(empty(), toWire(created.delta))).toBeNull();
  });

  it("REQ-007: setColor на существующий стикер классифицируется как editSticker", () => {
    const actor = newActor();
    const created = createSticker(empty(), newClock(actor), {
      column: "start",
      frac: "m",
      text: "hello",
      color: "yellow",
    });
    const stickerId = dotKey(created.dot) as EntityId;
    const state = created.delta as State;
    const edit = setColor(state, created.clock, stickerId, "green");
    expect(classifyAction(state, toWire(edit.delta))).toBe("editSticker");
  });

  it("REQ-011: setGroup на существующий стикер классифицируется как assignGroup", () => {
    const actor = newActor();
    const stickerCreated = createSticker(empty(), newClock(actor), {
      column: "start",
      frac: "m",
      text: "hello",
      color: "yellow",
    });
    const stickerId = dotKey(stickerCreated.dot) as EntityId;
    const groupCreated = createGroup(stickerCreated.delta as State, stickerCreated.clock, {
      column: "start",
      frac: "n",
      title: "Group A",
    });
    const groupId = dotKey(groupCreated.dot) as EntityId;
    const merged = merge(stickerCreated.delta as State, groupCreated.delta as State);
    const assignment = setGroup(merged, groupCreated.clock, stickerId, groupId);
    expect(classifyAction(merged, toWire(assignment.delta))).toBe("assignGroup");
  });

  it("write на существующую группу (не стикер) классифицируется как null", () => {
    const actor = newActor();
    const created = createGroup(empty(), newClock(actor), {
      column: "start",
      frac: "m",
      title: "Group A",
    });
    const groupId = dotKey(created.dot) as EntityId;
    const state = created.delta as State;
    const edit = setField(state, created.clock, { entity: groupId, field: "deleted" }, true);
    expect(classifyAction(state, toWire(edit.delta))).toBeNull();
  });

  it("write на существующий action item классифицируется как null (action item не гейтится в T-011)", () => {
    const actor = newActor();
    const created = createAction(empty(), newClock(actor), { text: "do the thing" });
    const actionId = dotKey(created.dot) as EntityId;
    const state = created.delta as State;
    const edit = setField(state, created.clock, { entity: actionId, field: "text" }, "changed");
    expect(classifyAction(state, toWire(edit.delta))).toBeNull();
  });

  it("REQ-015 (вне области, только форма): vote(...) классифицируется как null", () => {
    const actor = newActor();
    const created = createSticker(empty(), newClock(actor), {
      column: "start",
      frac: "m",
      text: "hello",
      color: "yellow",
    });
    const stickerId = dotKey(created.dot) as EntityId;
    const state = created.delta as State;
    const voted = vote(state, created.clock, stickerId, "voter-token");
    expect(classifyAction(state, toWire(voted.delta))).toBeNull();
  });

  it("REQ-015 (вне области, только форма): unvote(...) классифицируется как null", () => {
    const actor = newActor();
    const created = createSticker(empty(), newClock(actor), {
      column: "start",
      frac: "m",
      text: "hello",
      color: "yellow",
    });
    const stickerId = dotKey(created.dot) as EntityId;
    const state = created.delta as State;
    const voted = vote(state, created.clock, stickerId, "voter-token");
    const stateWithVote = merge(state, voted.delta);
    const unvoted = unvote(stateWithVote, voted.dot, stickerId);
    expect(classifyAction(stateWithVote, toWire(unvoted))).toBeNull();
  });
});
