#!/usr/bin/env node
// check:trace — трассируемость REQ ↔ задачи ↔ тесты (CLAUDE.md, правило 4; docs/tasks.md).
//
// Падает, если:
//   - REQ из requirements.md не входит ни в одну задачу;
//   - задача без REQ и без пометки infra;
//   - задача или тест ссылается на несуществующее REQ;
//   - у REQ из задачи со статусом done нет ни одного теста с этим ID.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const reqIds = (text) => [...new Set(text.match(/REQ-\d{3}/g) ?? [])];

const requirements = new Set();
for (const [, id, title] of read("docs/spec/requirements.md").matchAll(
  /^### (REQ-\d{3}):(.*)$/gm,
)) {
  if (!title.includes("~~")) requirements.add(id);
}

const tasks = read("docs/tasks.md")
  .split(/^(?=### T-\d{3})/m)
  .filter((block) => block.startsWith("### T-"))
  .map((block) => {
    const reqLine = block.match(/^- \*\*REQ:\*\*(.*)$/m)?.[1] ?? "";
    return {
      id: block.match(/^### (T-\d{3})/)[1],
      reqs: reqIds(reqLine),
      infra: /\binfra\b/.test(reqLine),
      status: block.match(/^- \*\*Статус:\*\*\s*(\S+)/m)?.[1] ?? "",
    };
  });

const testFiles = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(test|spec)\.(ts|tsx|js|mjs)$/.test(entry.name)) testFiles.push(full);
  }
};
for (const dir of ["apps", "packages", "e2e"]) {
  try {
    walk(path.join(root, dir));
  } catch {}
}

const tested = new Map();
for (const file of testFiles) {
  for (const id of reqIds(readFileSync(file, "utf8"))) {
    tested.set(id, [...(tested.get(id) ?? []), path.relative(root, file)]);
  }
}

const errors = [];
for (const task of tasks) {
  if (task.reqs.length === 0 && !task.infra) errors.push(`${task.id}: нет REQ и нет пометки infra`);
  for (const id of task.reqs) {
    if (!requirements.has(id)) errors.push(`${task.id}: ссылается на несуществующее ${id}`);
    if (task.status === "done" && !tested.has(id)) {
      errors.push(`${task.id} (done): у ${id} нет ни одного теста с этим ID`);
    }
  }
}
const inTasks = new Set(tasks.flatMap((task) => task.reqs));
for (const id of requirements) {
  if (!inTasks.has(id)) errors.push(`${id}: не входит ни в одну задачу docs/tasks.md`);
}
for (const [id, files] of tested) {
  if (!requirements.has(id)) errors.push(`${files.join(", ")}: ссылается на несуществующее ${id}`);
}

const done = tasks.filter((task) => task.status === "done").length;
console.log(
  `check:trace: ${requirements.size} REQ, ${tasks.length} задач (${done} done), ${testFiles.length} тестовых файлов, ${tested.size} REQ с тестами`,
);
if (errors.length > 0) {
  for (const error of errors) console.error(`  ✗ ${error}`);
  process.exit(1);
}
