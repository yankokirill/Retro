#!/usr/bin/env node
// Stop hook: if there are commits newer than the last journal update, ask the agent to run /journal once.
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
if (input.stop_hook_active) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
const git = (...args) => {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
};

const top = git("rev-parse", "--show-toplevel");
if (!top || path.resolve(top) !== path.resolve(root)) process.exit(0);

const lastCommitSec = Number(git("log", "-1", "--format=%ct"));
if (!lastCommitSec) process.exit(0);

// "Обновлён журнал" значит одно из двух: последний коммит, тронувший
// journal.md (учитывает случай, когда сам коммит и добавил запись —
// mtime файла на диске в этот момент ещё старше времени commit), или
// файл правили на диске позже любого коммита (запись уже готова, просто
// ещё не закоммичена). Берём максимум, чтобы не ловить оба ложных срабатывания.
const journalGitSec = Number(git("log", "-1", "--format=%ct", "--", "docs/report/journal.md")) || 0;

let journalMtimeSec = 0;
try {
  journalMtimeSec = statSync(path.join(root, "docs", "report", "journal.md")).mtimeMs / 1000;
} catch {}

const journalSec = Math.max(journalGitSec, journalMtimeSec);

if (lastCommitSec > journalSec) {
  console.error(
    "Есть коммиты новее последней записи журнала. Выполни /journal и затем заверши работу.",
  );
  process.exit(2);
}
