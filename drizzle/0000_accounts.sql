CREATE TABLE members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  student_number TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  profile TEXT NOT NULL DEFAULT '{}'
);
--> statement-breakpoint
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX sessions_expires ON sessions(expires);
--> statement-breakpoint
CREATE TABLE attempts (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX attempts_expires ON attempts(expires);
