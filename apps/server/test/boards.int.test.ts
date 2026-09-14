// REQ-001, REQ-002, REQ-003 — создание доски, гостевая сессия, роли по ссылкам-приглашениям (T-007).
// docs/spec/requirements.md, docs/adr/0007-invite-links-per-role.md, docs/spec/protocol.md § 7.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { grantFacilitator } from "../src/boards/service.js";
import * as schema from "../src/db/schema.js";

const GUEST_ID_HEADER = "x-guest-id";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let app: FastifyInstance;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
  app = buildApp({ db });
}, 60_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

const newGuestId = () => crypto.randomUUID();

interface CreateBoardBody {
  boardId: string;
  participantLink: string;
  viewerLink: string;
}

async function createBoard(
  guestId: string,
  body: { title?: string; displayName?: string; voteLimit?: number },
) {
  const res = await app.inject({
    method: "POST",
    url: "/api/boards",
    headers: { [GUEST_ID_HEADER]: guestId },
    payload: { title: "Sprint 1 retro", displayName: "Facilitator", ...body },
  });
  return res;
}

async function joinByLink(linkToken: string, guestId: string, displayName: string) {
  return app.inject({
    method: "GET",
    url: `/api/boards/join/${linkToken}?displayName=${encodeURIComponent(displayName)}`,
    headers: { [GUEST_ID_HEADER]: guestId },
  });
}

async function getBoard(boardId: string, guestId: string) {
  return app.inject({
    method: "GET",
    url: `/api/boards/${boardId}`,
    headers: { [GUEST_ID_HEADER]: guestId },
  });
}

describe("REQ-001: создание доски", () => {
  it("REQ-001 кр.1: доска создаётся в фазе collect, создатель становится owner", async () => {
    const ownerId = newGuestId();
    const created = await createBoard(ownerId, { voteLimit: 5 });
    expect(created.statusCode).toBe(201);
    const body = created.json<CreateBoardBody>();

    const board = await getBoard(body.boardId, ownerId);
    expect(board.statusCode).toBe(200);
    const meta = board.json();
    expect(meta.phase).toBe("collect");
    expect(meta.role).toBe("owner");
  });

  it("REQ-001 кр.2: voteLimit не указан — используется значение по умолчанию N=3", async () => {
    const ownerId = newGuestId();
    const created = await createBoard(ownerId, {});
    expect(created.statusCode).toBe(201);
    const body = created.json<CreateBoardBody>();

    const board = await getBoard(body.boardId, ownerId);
    expect(board.json().voteLimit).toBe(3);
  });

  it("REQ-001 кр.3: voteLimit вне диапазона 1..10 отклоняется", async () => {
    const tooLow = await createBoard(newGuestId(), { voteLimit: 0 });
    expect(tooLow.statusCode).toBe(400);

    const tooHigh = await createBoard(newGuestId(), { voteLimit: 11 });
    expect(tooHigh.statusCode).toBe(400);
  });

  it("REQ-001 кр.4: ответ содержит две РАЗНЫЕ ссылки-приглашения (ADR-0007)", async () => {
    const created = await createBoard(newGuestId(), {});
    expect(created.statusCode).toBe(201);
    const body = created.json<CreateBoardBody>();
    expect(body.participantLink).toBeTruthy();
    expect(body.viewerLink).toBeTruthy();
    expect(body.participantLink).not.toBe(body.viewerLink);
  });
});

describe("REQ-002: роль по ссылке-приглашению (ADR-0007)", () => {
  it("REQ-002 кр.5: первый заход по participantLink даёт роль participant, по viewerLink — viewer", async () => {
    const created = await createBoard(newGuestId(), {});
    const { boardId, participantLink, viewerLink } = created.json<CreateBoardBody>();

    const participantId = newGuestId();
    const joinAsParticipant = await joinByLink(participantLink, participantId, "Alice");
    expect(joinAsParticipant.statusCode).toBe(200);
    expect(joinAsParticipant.json().role).toBe("participant");
    expect(joinAsParticipant.json().boardId).toBe(boardId);
    const participantBoard = await getBoard(boardId, participantId);
    expect(participantBoard.json().role).toBe("participant");

    const viewerId = newGuestId();
    const joinAsViewer = await joinByLink(viewerLink, viewerId, "Bob");
    expect(joinAsViewer.statusCode).toBe(200);
    expect(joinAsViewer.json().role).toBe("viewer");
    const viewerBoard = await getBoard(boardId, viewerId);
    expect(viewerBoard.json().role).toBe("viewer");
  });

  it("REQ-002 кр.6: повторный заход по ссылке другой роли не меняет уже сохранённую роль", async () => {
    const created = await createBoard(newGuestId(), {});
    const { boardId, participantLink, viewerLink } = created.json<CreateBoardBody>();

    const guestId = newGuestId();
    const first = await joinByLink(participantLink, guestId, "Carol");
    expect(first.json().role).toBe("participant");

    const second = await joinByLink(viewerLink, guestId, "Carol");
    expect(second.statusCode).toBe(200);
    expect(second.json().role).toBe("participant");

    const direct = await getBoard(boardId, guestId);
    expect(direct.json().role).toBe("participant");
  });

  it("REQ-002 кр.7: два разных гостя по одной ссылке получают одну и ту же роль", async () => {
    const created = await createBoard(newGuestId(), {});
    const { participantLink } = created.json<CreateBoardBody>();

    const first = newGuestId();
    const second = newGuestId();
    const joinedFirst = await joinByLink(participantLink, first, "Dave");
    const joinedSecond = await joinByLink(participantLink, second, "Erin");

    expect(joinedFirst.json().role).toBe("participant");
    expect(joinedSecond.json().role).toBe("participant");
  });

  it("REQ-002 кр.8: гость без join и не owner получает 404 при прямом запросе доски", async () => {
    const created = await createBoard(newGuestId(), {});
    const { boardId } = created.json<CreateBoardBody>();

    const strangerId = newGuestId();
    const res = await getBoard(boardId, strangerId);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });
});

describe("REQ-003: роли по умолчанию и назначение фасилитатора", () => {
  it("REQ-003 кр.1: создатель доски — owner (все права facilitator без отдельной роли)", async () => {
    const ownerId = newGuestId();
    const created = await createBoard(ownerId, {});
    const { boardId } = created.json<CreateBoardBody>();

    const board = await getBoard(boardId, ownerId);
    expect(board.json().role).toBe("owner");
  });

  it("REQ-003 кр.2: owner назначает участника facilitator; можно назначить нескольких; owner не теряет свою роль", async () => {
    const ownerId = newGuestId();
    const created = await createBoard(ownerId, {});
    const { boardId, participantLink } = created.json<CreateBoardBody>();

    const targetA = newGuestId();
    const targetB = newGuestId();
    await joinByLink(participantLink, targetA, "Frank");
    await joinByLink(participantLink, targetB, "Grace");

    const resultA = await grantFacilitator(db, {
      boardId,
      granterGuestId: ownerId,
      targetGuestId: targetA,
    });
    expect(resultA).toBe("ok");

    const resultB = await grantFacilitator(db, {
      boardId,
      granterGuestId: ownerId,
      targetGuestId: targetB,
    });
    expect(resultB).toBe("ok");

    const boardA = await getBoard(boardId, targetA);
    expect(boardA.json().role).toBe("facilitator");
    const boardB = await getBoard(boardId, targetB);
    expect(boardB.json().role).toBe("facilitator");

    const ownerBoard = await getBoard(boardId, ownerId);
    expect(ownerBoard.json().role).toBe("owner");
  });

  it("REQ-003 кр.3: не-owner не может назначить facilitator", async () => {
    const ownerId = newGuestId();
    const created = await createBoard(ownerId, {});
    const { boardId, participantLink } = created.json<CreateBoardBody>();

    const participantId = newGuestId();
    await joinByLink(participantLink, participantId, "Henry");
    const targetId = newGuestId();
    await joinByLink(participantLink, targetId, "Ivy");

    const result = await grantFacilitator(db, {
      boardId,
      granterGuestId: participantId,
      targetGuestId: targetId,
    });
    expect(result).toBe("not_owner");

    const targetBoard = await getBoard(boardId, targetId);
    expect(targetBoard.json().role).toBe("participant");
  });

  it("REQ-003: grantFacilitator для гостя без членства в доске возвращает target_not_member", async () => {
    const ownerId = newGuestId();
    const created = await createBoard(ownerId, {});
    const { boardId } = created.json<CreateBoardBody>();

    const notMemberId = newGuestId();
    const result = await grantFacilitator(db, {
      boardId,
      granterGuestId: ownerId,
      targetGuestId: notMemberId,
    });
    expect(result).toBe("target_not_member");
  });
});
