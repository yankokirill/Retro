ALTER TABLE "boards" ADD COLUMN "reveal_seq" bigint;
--> statement-breakpoint
-- T-026, code-review PR #19 (находка 2): доски, уже покинувшие collect до
-- этой миграции, не должны остаться с reveal_seq = NULL — иначе досылка
-- скрытого при переподключении (H1, ВС-2(б) docs/spec/simulator.md § 13)
-- для них никогда не сработает. Значение то же, что setPhase вычислил бы
-- сам в момент их настоящего reveal: максимальный seq журнала доски (0,
-- если строк ещё нет).
UPDATE "boards"
SET "reveal_seq" = COALESCE(
  (SELECT MAX("seq") FROM "ops" WHERE "ops"."board_id" = "boards"."id"),
  0
)
WHERE "phase" <> 'collect';