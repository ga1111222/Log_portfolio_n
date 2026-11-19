CREATE TABLE member_invites (
  token_hash TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  expires INTEGER NOT NULL
);
--> statement-breakpoint
ALTER TABLE members ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1));
--> statement-breakpoint
ALTER TABLE members ADD COLUMN invite_hash TEXT;
--> statement-breakpoint
ALTER TABLE members ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE UNIQUE INDEX members_invite_hash ON members(invite_hash) WHERE invite_hash IS NOT NULL;
