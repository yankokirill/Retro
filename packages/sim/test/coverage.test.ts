// SIM-11 — docs/spec/simulator.md § 10.1: «проверка не пуста». Читает
// `.coverage/*.json`, которые пишут файлы матрицы (matrix-case.ts), и требует
// каждое условие хотя бы в одном прогоне набора. Запускается ВТОРЫМ шагом
// `npm run test:sim` (после матрицы).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROFILES } from "../src/index.js";

const DIR = join(import.meta.dirname, "..", ".coverage");
const FIXED_SEEDS = [1, 2, 3, 4];
const S7_REASONS = [
  "wrong_phase",
  "vote_limit",
  "unknown_target",
  "not_own_vote",
  "stale_dot",
  "unjustified_supersede",
  "irreversible_phase",
] as const;
const BOOLEAN_FLAGS = [
  "revealWithDisconnectedMissingStickers",
  "conflictAtCheckpoint",
  "duplicateAckWrite",
  "duplicateAckUnvote",
  "voteLimitFromOwnTabs",
  "welcomeWithSnapshot",
  "welcomeTailOnly",
  "reloadWithNonEmptyPending",
  "resetVotesConcurrentWithUnvote",
  "opBuiltOnRejectedUnconfirmed",
] as const;

interface Record_ {
  profile: string;
  seed: number;
  coverage: Record<string, unknown> & { rejectReasonsSeen: string[] };
  faultCoverage: Record<string, boolean>;
}

function load(): { names: string[]; records: Record_[] } {
  if (!existsSync(DIR)) {
    throw new Error(
      "нет данных матрицы; запустите npm run test:sim (сначала матрица, затем coverage.test.ts)",
    );
  }
  const names = readdirSync(DIR).filter((n) => n.endsWith(".json"));
  if (names.length === 0) {
    throw new Error(
      "нет данных матрицы; запустите npm run test:sim (сначала матрица, затем coverage.test.ts)",
    );
  }
  return {
    names,
    records: names.map((n) => JSON.parse(readFileSync(join(DIR, n), "utf8")) as Record_),
  };
}

describe("SIM-11: трудные ситуации действительно происходят", () => {
  it("SIM-11 / REQ-022: данные матрицы полны — ≥ 25 файлов, все 24 фиксированные пары профиль × seed", () => {
    const { names } = load();
    expect(names.length, `найдено файлов: ${names.length}`).toBeGreaterThanOrEqual(25);
    const missing: string[] = [];
    for (const profile of PROFILES) {
      for (const seed of FIXED_SEEDS) {
        if (!names.includes(`${profile}-seed${seed}.json`)) missing.push(`${profile}-seed${seed}`);
      }
    }
    expect(missing, `нет данных для пар: ${missing.join(", ")}`).toEqual([]);
  });

  it("SIM-11 / REQ-022: суммарно по набору наступило каждое условие § 10.1", () => {
    const { records } = load();
    const notHappened: string[] = [];
    for (const flag of BOOLEAN_FLAGS) {
      if (!records.some((r) => r.coverage[flag] === true)) notHappened.push(flag);
    }
    const seen = new Set(records.flatMap((r) => r.coverage.rejectReasonsSeen ?? []));
    for (const reason of S7_REASONS) {
      if (!seen.has(reason)) notHappened.push(`rejectReason:${reason}`);
    }
    expect(
      notHappened,
      `проверка пуста: не наступили ни в одном прогоне: ${notHappened.join(", ")}`,
    ).toEqual([]);
  });
});
