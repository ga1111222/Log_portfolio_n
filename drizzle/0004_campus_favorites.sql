CREATE TABLE campus_favorites (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  notice_key TEXT NOT NULL,
  data TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY (member_id, notice_key)
);
