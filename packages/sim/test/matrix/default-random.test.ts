// SIM-09: один случайный seed на профиль default (docs/spec/simulator.md § 11.2).
// Seed печатается — упавший прогон воспроизводится подстановкой в SIM_SEED.
import { defineMatrixCase } from "../matrix-case.js";

const seed = Number(process.env.SIM_SEED ?? Math.floor(Math.random() * 2 ** 31));
console.log(`SIM-09: случайный seed профиля default = ${seed} (повтор: SIM_SEED=${seed})`);
defineMatrixCase("default", seed, 5, "default-random.json");
