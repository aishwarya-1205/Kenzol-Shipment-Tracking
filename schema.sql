-- Each workbook row is stored as JSON keyed by its Excel header, so the
-- columns you have in the sheet (including ones I haven't seen) are all kept.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rows (
  rownum INTEGER PRIMARY KEY,           -- original Excel row number
  bl_key TEXT NOT NULL DEFAULT '',      -- '|TOKEN1|TOKEN2|' normalized BL tokens
  data   TEXT NOT NULL                  -- JSON object: { "BL NUMBER": "...", ... }
);
