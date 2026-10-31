-- Oxford Word Knight — 只读统计库
--
-- 设计原则（对应「精简版」的隐私边界）：
--   · 不存 IP
--   · 不存孩子的原始输入（拼错的具体字符串）
--   · 不存姓名、学校、任何可识别信息
--   · code 只是家庭码，用来区分不同设备/家庭，不可反查身份
--
-- 一次闯关 = 1 行 rounds + 8 行 answers，约 4 KB 里只留最必要的字段。

CREATE TABLE IF NOT EXISTS rounds (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT    NOT NULL DEFAULT '',
  character  TEXT    NOT NULL DEFAULT '',
  level      TEXT    NOT NULL DEFAULT '',
  score      INTEGER NOT NULL DEFAULT 0,
  correct    INTEGER NOT NULL DEFAULT 0,
  total      INTEGER NOT NULL DEFAULT 0,
  max_combo  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rounds_created ON rounds(created_at);
CREATE INDEX IF NOT EXISTS idx_rounds_code    ON rounds(code);

CREATE TABLE IF NOT EXISTS answers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id   INTEGER NOT NULL DEFAULT 0,
  code       TEXT    NOT NULL DEFAULT '',
  type       TEXT    NOT NULL DEFAULT '',
  word       TEXT    NOT NULL DEFAULT '',
  correct    INTEGER NOT NULL DEFAULT 0,
  ms         INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_answers_round   ON answers(round_id);
CREATE INDEX IF NOT EXISTS idx_answers_word    ON answers(word);
CREATE INDEX IF NOT EXISTS idx_answers_created ON answers(created_at);
