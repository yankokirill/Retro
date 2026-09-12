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

let journalSec = 0;
try {
  journalSec = statSync(path.join(root, "docs", "report", "journal.md")).mtimeMs / 1000;
} catch {}

if (lastCommitSec > journalSec) {
  console.error(
    "Есть коммиты новее последней записи журнала. Выполни /journal и затем заверши работу.",
  );
  process.exit(2);
}
