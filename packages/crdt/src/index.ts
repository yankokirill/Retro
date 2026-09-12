// Ядро CRDT доски: состояние X = (C, E, S, V+, V-), merge, materialize, compact.
//
// Заготовка вехи В1 — намеренно пуста. Реализация ведётся требование за
// требованием на вехе В2+ по чеклисту .claude/skills/crdt-op/SKILL.md,
// на основе модели в docs/spec/consistency-model.md. Пакет не должен
// зависеть от I/O, Date.now() или Math.random() — время и случайность
// приходят параметрами (см. CLAUDE.md, правило 7).

export {};
