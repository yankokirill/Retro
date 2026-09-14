CREATE TABLE "authors" (
	"board_id" uuid NOT NULL,
	"entity_id" text NOT NULL,
	"guest_id" uuid NOT NULL,
	CONSTRAINT "authors_board_id_entity_id_pk" PRIMARY KEY("board_id","entity_id")
);
--> statement-breakpoint
ALTER TABLE "authors" ADD CONSTRAINT "authors_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE no action ON UPDATE no action;