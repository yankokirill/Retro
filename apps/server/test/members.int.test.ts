// REQ-003 (кр. 2) — GET /api/boards/:boardId/members (T-018, docs/design/T-018-phases-ui.md § 1,
// docs/spec/protocol.md § 7). Postgres в Testcontainers, по образцу boards.int.test.ts.
import { membersResponseSchema } from "@retro/protocol";
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

async function createBoard(guestId: string, displayName = "Владелец") {
  const res = await app.inject({
    method: "POST",
    url: "/api/boards",
    headers: { [GUEST_ID_HEADER]: guestId },
    payload: { title: "Ретро", displayName },
  });
  return res.json<CreateBoardBody>();
}

async function join(linkToken: string, guestId: string, displayName: string) {
  return app.inject({
    method: "GET",
    url: `/api/boards/join/${linkToken}?displayName=${encodeURIComponent(displayName)}`,
    headers: { [GUEST_ID_HEADER]: guestId },
  });
}

function listMembers(boardId: string, guestId?: string) {
  return app.inject({
    method: "GET",
    url: `/api/boards/${boardId}/members`,
    headers: guestId === undefined ? {} : { [GUEST_ID_HEADER]: guestId },
  });
}

describe("REQ-003: GET /api/boards/:boardId/members", () => {
  it("REQ-003 кр.2: без заголовка X-Guest-Id — 400", async () => {
    const owner = newGuestId();
    const { boardId } = await createBoard(owner);
    const res = await listMembers(boardId);
    expect(res.statusCode).toBe(400);
  });

  it("REQ-003 кр.2: boardId не UUID — 400", async () => {
    const res = await listMembers("not-a-uuid", newGuestId());
    expect(res.statusCode).toBe(400);
  });

  it("REQ-003 кр.2: несуществующая доска — 404", async () => {
    const res = await listMembers(crypto.randomUUID(), newGuestId());
    expect(res.statusCode).toBe(404);
  });

  it("REQ-003 кр.2: гость без записи в members получает 404, а не 403", async () => {
    const owner = newGuestId();
    const { boardId } = await createBoard(owner);
    const res = await listMembers(boardId, newGuestId());
    expect(res.statusCode).toBe(404);
  });

  it("REQ-003 кр.2: participant и viewer получают 403 forbidden", async () => {
    const owner = newGuestId();
    const { boardId, participantLink, viewerLink } = await createBoard(owner);
    const participant = newGuestId();
    const viewer = newGuestId();
    await join(participantLink, participant, "Аня");
    await join(viewerLink, viewer, "Боря");

    for (const guest of [participant, viewer]) {
      const res = await listMembers(boardId, guest);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("forbidden");
    }
  });

  it("REQ-003 кр.2: owner получает 200, владелец первым, поля guestId/displayName/role", async () => {
    const owner = newGuestId();
    const { boardId, participantLink, viewerLink } = await createBoard(owner, "Оля");
    const a = newGuestId();
    const b = newGuestId();
    await join(participantLink, a, "Аня");
    await join(viewerLink, b, "Боря");

    const res = await listMembers(boardId, owner);
    expect(res.statusCode).toBe(200);
    const parsed = membersResponseSchema.parse(res.json());
    expect(parsed.members).toEqual([
      { guestId: owner, displayName: "Оля", role: "owner" },
      { guestId: a, displayName: "Аня", role: "participant" },
      { guestId: b, displayName: "Боря", role: "viewer" },
    ]);
  });

  it("REQ-003 кр.2: порядок — по времени входа", async () => {
    const owner = newGuestId();
    const { boardId, participantLink } = await createBoard(owner);
    const guests = [newGuestId(), newGuestId(), newGuestId(), newGuestId()];
    for (const [i, g] of guests.entries()) await join(participantLink, g, `Гость ${i}`);

    const res = await listMembers(boardId, owner);
    const ids = membersResponseSchema.parse(res.json()).members.map((m) => m.guestId);
    expect(ids).toEqual([owner, ...guests]);
  });

  it("REQ-003 кр.2: facilitator получает 200, назначенная роль видна в списке", async () => {
    const owner = newGuestId();
    const { boardId, participantLink } = await createBoard(owner);
    const facilitator = newGuestId();
    const other = newGuestId();
    await join(participantLink, facilitator, "Фаня");
    await join(participantLink, other, "Оля2");
    expect(
      await grantFacilitator(db, {
        boardId,
        granterGuestId: owner,
        targetGuestId: facilitator,
      }),
    ).toBe("ok");

    const res = await listMembers(boardId, facilitator);
    expect(res.statusCode).toBe(200);
    const roles = Object.fromEntries(
      membersResponseSchema.parse(res.json()).members.map((m) => [m.guestId, m.role]),
    );
    expect(roles[facilitator]).toBe("facilitator");
    expect(roles[owner]).toBe("owner");
    expect(roles[other]).toBe("participant");
  });

  it("REQ-003 кр.2: участники другой доски в список не попадают", async () => {
    const ownerA = newGuestId();
    const ownerB = newGuestId();
    const boardA = await createBoard(ownerA);
    const boardB = await createBoard(ownerB);
    await join(boardB.participantLink, newGuestId(), "Чужой");

    const res = await listMembers(boardA.boardId, ownerA);
    expect(membersResponseSchema.parse(res.json()).members.map((m) => m.guestId)).toEqual([ownerA]);
  });
});
