#!/usr/bin/env node
// PreToolUse hook for Bash.
// Always: no force push; git writes only when the git root is this project;
//         with .claude/protect-main present, no commits/pushes on main.
// --readonly: additionally blocks git writes and file-modifying shell commands
//             (used by the independent reviewer).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const readonly = process.argv.includes("--readonly");

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
const cmd = input.tool_input?.command ?? "";
const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();

const deny = (message) => {
  console.error(message);
  process.exit(2);
};
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

const gitWrite =
  /\bgit\s+(?:-C\s+\S+\s+)?(add|commit|push|merge|rebase|reset|checkout|switch|stash|tag|branch\s+-[dDmM])\b/;

if (readonly) {
  if (gitWrite.test(cmd))
    deny("Проверяющий работает только на чтение: git-операции, меняющие репозиторий, запрещены.");
  if (/(^|[;&|(]\s*)(rm|mv|cp|sed\s+-i|tee|truncate|chmod)\b/.test(cmd))
    deny("Проверяющий работает только на чтение: команды, меняющие файлы, запрещены.");
  if (/(?<![0-9&>])>(?!&|\s*\/dev\/null)/.test(cmd))
    deny("Проверяющий работает только на чтение: перенаправление вывода в файл запрещено.");
}

if (/\bgit\b[^;&|]*\bpush\b[^;&|]*(\s--force\b|\s-f\b|\s--force-with-lease\b)/.test(cmd)) {
  deny("Force push запрещён.");
}

if (gitWrite.test(cmd)) {
  const top = git("rev-parse", "--show-toplevel");
  if (!top || path.resolve(top) !== path.resolve(root)) {
    deny(
      `git-репозиторий (${top || "не найден"}) не совпадает с корнем проекта ${root}. Сначала выполните git init в проекте.`,
    );
  }

  if (existsSync(path.join(root, ".claude", "protect-main"))) {
    const onMain = git("branch", "--show-current") === "main";
    if (onMain && /\bgit\s+(commit|merge|rebase|reset)\b/.test(cmd)) {
      deny("Коммиты в main запрещены: создайте ветку feat/REQ-XXX-... и откройте PR.");
    }
    if (/\bgit\s+push\b/.test(cmd) && (onMain || /[\s:]main(\s|$)/.test(cmd))) {
      deny("Push в main запрещён: изменения попадают в main только через PR.");
    }
  }
}
