CREATE TABLE "ops" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"board_id" uuid NOT NULL,
	"actor" uuid NOT NULL,
	"counter" integer NOT NULL,
	"lamport" integer NOT NULL,
	"delta" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_board_id_actor_counter_unique" UNIQUE("board_id","actor","counter")
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"board_id" uuid NOT NULL,
	"upto_seq" bigint NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "snapshots_board_id_upto_seq_pk" PRIMARY KEY("board_id","upto_seq")
);
--> statement-breakpoint
ALTER TABLE "ops" ADD CONSTRAINT "ops_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE no action ON UPDATE no action;