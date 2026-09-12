#!/usr/bin/env node
// PreToolUse hook: restricts file tools to (or away from) project-relative globs.
// Usage: guard-paths.mjs --allow <glob>...   block everything outside the globs
//        guard-paths.mjs --deny  <glob>...   block everything inside the globs
// Exit code 2 blocks the tool call and shows stderr to the agent.
import path from "node:path";

const [mode, ...globs] = process.argv.slice(2);
if (!["--allow", "--deny"].includes(mode) || globs.length === 0) {
  console.error("guard-paths: usage: --allow|--deny <glob>...");
  process.exit(2);
}

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
const toolInput = input.tool_input ?? {};
const target = toolInput.file_path ?? toolInput.path ?? toolInput.notebook_path;

// Grep/Glob without an explicit path search the whole project; nothing to check.
if (!target) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
const rel = path.relative(root, path.resolve(root, target)).split(path.sep).join("/");
const outside = rel.startsWith("..") || path.isAbsolute(rel);
const matched = !outside && globs.some((glob) => path.matchesGlob(rel, glob));

if (mode === "--allow" && !matched) {
  console.error(`Запрещено: ${input.tool_name} ${rel}. Разрешены только: ${globs.join(", ")}`);
  process.exit(2);
}
if (mode === "--deny" && matched) {
  console.error(
    `Запрещено: ${input.tool_name} ${rel}. Этому агенту недоступны: ${globs.join(", ")}`,
  );
  process.exit(2);
}
