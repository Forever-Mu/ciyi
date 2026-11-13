/**
 * schema.js —— SQLite 表结构与迁移
 *
 * 全应用唯一的 schema 定义，node 测试与浏览器/APK 共用。
 */

export const SCHEMA_VERSION = 1;

export const DDL = [
  /* ------------------------------------------------ 词库（每次导入一条） */
  `CREATE TABLE IF NOT EXISTS word_lists (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     name         TEXT    NOT NULL,
     source_type  TEXT    NOT NULL,          -- docx | paste
     source_name  TEXT,
     word_count   INTEGER NOT NULL DEFAULT 0,
     created_at   TEXT    NOT NULL
   )`,

  /* ------------------------------------------------ 单词主表 */
  `CREATE TABLE IF NOT EXISTS words (
     id                       INTEGER PRIMARY KEY AUTOINCREMENT,
     word                     TEXT    NOT NULL,   -- 规范化 key（小写去空白），用于去重
     display_word             TEXT    NOT NULL,   -- 展示用（保留原始大小写）
     original_translation     TEXT,               -- Word 原始释义（永不覆盖）
     suggested_translation    TEXT,               -- 系统推荐释义
     confirmed_translation    TEXT,               -- 用户最终确认释义
     part_of_speech           TEXT,               -- 逗号分隔，如 "n,v,adj"
     uk_ipa                   TEXT,
     us_ipa                   TEXT,
     english_example          TEXT,
     example_translation      TEXT,
     translation_check_status TEXT    NOT NULL DEFAULT 'pending',  -- A|B|C|D|E|pending
     translation_check_confidence REAL,
     translation_check_reason TEXT,
     dictionary_data          TEXT,               -- 词典原始返回（JSON）
     created_at               TEXT    NOT NULL,
     updated_at               TEXT    NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_words_word ON words(word)`,

  /* ------------------------------------------------ 词库与单词关联 */
  `CREATE TABLE IF NOT EXISTS word_list_items (
     id       INTEGER PRIMARY KEY AUTOINCREMENT,
     list_id  INTEGER NOT NULL REFERENCES word_lists(id) ON DELETE CASCADE,
     word_id  INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
     raw_line TEXT,
     UNIQUE(list_id, word_id)
   )`,
  `CREATE INDEX IF NOT EXISTS ix_wli_word ON word_list_items(word_id)`,

  /* ------------------------------------------------ 答题流水 */
  `CREATE TABLE IF NOT EXISTS learning_records (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     word_id       INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
     mode          TEXT    NOT NULL,   -- new | reinforce | review
     question_type TEXT    NOT NULL,   -- en2cn | cn2en | spell | en2def
     is_correct    INTEGER NOT NULL,
     user_answer   TEXT,
     is_first_of_day INTEGER NOT NULL DEFAULT 0,
     local_date    TEXT    NOT NULL,
     created_at    TEXT    NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS ix_lr_word  ON learning_records(word_id)`,
  `CREATE INDEX IF NOT EXISTS ix_lr_date  ON learning_records(local_date)`,
  `CREATE INDEX IF NOT EXISTS ix_lr_wdate ON learning_records(word_id, local_date)`,

  /* ------------------------------------------------ 记忆状态 / 复习计划 */
  `CREATE TABLE IF NOT EXISTS review_schedule (
     word_id          INTEGER PRIMARY KEY REFERENCES words(id) ON DELETE CASCADE,
     state            TEXT    NOT NULL DEFAULT 'new',   -- new|learning|consolidating|mastered|fragile
     ease             REAL    NOT NULL DEFAULT 2.3,     -- 难度系数 1.3~2.6
     interval_days    REAL    NOT NULL DEFAULT 0,
     repetitions      INTEGER NOT NULL DEFAULT 0,       -- 连续成功的长期复习次数
     lapses           INTEGER NOT NULL DEFAULT 0,       -- 遗忘(lapse)次数
     streak_correct   INTEGER NOT NULL DEFAULT 0,
     streak_wrong     INTEGER NOT NULL DEFAULT 0,
     total_answers    INTEGER NOT NULL DEFAULT 0,
     total_correct    INTEGER NOT NULL DEFAULT 0,
     total_wrong      INTEGER NOT NULL DEFAULT 0,
     difficulty       REAL    NOT NULL DEFAULT 0.3,     -- 0~1，越高越难
     stability        REAL    NOT NULL DEFAULT 1.0,     -- 记忆稳定度（天）
     first_studied_at TEXT,
     last_studied_at  TEXT,
     last_reviewed_at TEXT,
     due_at           TEXT                              -- 下次复习日期 YYYY-MM-DD
   )`,
  `CREATE INDEX IF NOT EXISTS ix_rs_due ON review_schedule(due_at)`,
  `CREATE INDEX IF NOT EXISTS ix_rs_state ON review_schedule(state)`,

  /* ------------------------------------------------ 每日任务 */
  `CREATE TABLE IF NOT EXISTS daily_tasks (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     local_date   TEXT    NOT NULL,
     kind         TEXT    NOT NULL,                 -- new | review | reinforce
     word_id      INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
     position     INTEGER NOT NULL DEFAULT 0,
     status       TEXT    NOT NULL DEFAULT 'pending', -- pending|done|carried
     is_carryover INTEGER NOT NULL DEFAULT 0,        -- 是否为昨天及更早的未完成任务
     origin_date  TEXT,                              -- 该任务最初生成的日期
     round        INTEGER NOT NULL DEFAULT 0,        -- 强化轮次（仅 reinforce 使用）
     created_at   TEXT    NOT NULL,
     completed_at TEXT
   )`,
  // 新词/复习：同一天同一个词只能有一条
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_dt_once
     ON daily_tasks(local_date, kind, word_id) WHERE kind IN ('new','review')`,
  // 强化：同一个词同一天可以有多轮（round 递增）
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_dt_round
     ON daily_tasks(local_date, kind, word_id, round) WHERE kind = 'reinforce'`,
  `CREATE INDEX IF NOT EXISTS ix_dt_date ON daily_tasks(local_date, kind, status)`,

  /* ------------------------------------------------ 每日进度 */
  `CREATE TABLE IF NOT EXISTS daily_progress (
     local_date        TEXT PRIMARY KEY,
     new_target        INTEGER NOT NULL DEFAULT 50,
     new_done          INTEGER NOT NULL DEFAULT 0,
     review_done       INTEGER NOT NULL DEFAULT 0,
     reinforce_done    INTEGER NOT NULL DEFAULT 0,
     total_answers     INTEGER NOT NULL DEFAULT 0,
     correct_answers   INTEGER NOT NULL DEFAULT 0,
     updated_at        TEXT
   )`,

  /* ------------------------------------------------ 翻译核对历史 */
  `CREATE TABLE IF NOT EXISTS translation_check_records (
     id                    INTEGER PRIMARY KEY AUTOINCREMENT,
     word_id               INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
     batch_id              TEXT,
     original_translation  TEXT,
     dictionary_reference  TEXT,
     suggested_translation TEXT,
     status                TEXT,
     confidence            REAL,
     reason                TEXT,
     sources               TEXT,
     user_action           TEXT,          -- keep|adopt|manual|skip
     created_at            TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS ix_tcr_word ON translation_check_records(word_id)`,
  `CREATE INDEX IF NOT EXISTS ix_tcr_batch ON translation_check_records(batch_id)`,

  /* ------------------------------------------------ 学习计划 */
  // 同一时间只允许一个 active 计划。开始计划后才每天自动排任务。
  `CREATE TABLE IF NOT EXISTS study_plan (
     id               INTEGER PRIMARY KEY AUTOINCREMENT,
     started_at       TEXT    NOT NULL,           -- 开始日期 YYYY-MM-DD
     words_per_day    INTEGER NOT NULL,           -- 每天背多少新词
     target_words     INTEGER NOT NULL,           -- 本计划覆盖多少词（开始时未学词数）
     spelling_enabled INTEGER NOT NULL DEFAULT 1, -- 是否启用拼写模式
     status           TEXT    NOT NULL DEFAULT 'active',  -- active | finished | cancelled
     finished_at      TEXT,
     created_at       TEXT    NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS ix_plan_status ON study_plan(status)`,

  /* ------------------------------------------------ 设置 */
  `CREATE TABLE IF NOT EXISTS app_settings (
     key   TEXT PRIMARY KEY,
     value TEXT
   )`,
];

export const DEFAULT_SETTINGS = {
  daily_new_target: '50',
  theme: 'auto',
  question_types: 'en2cn,cn2en,spell,en2def',
  spelling_enabled: '1',
  reinforce_extra: '2',
  reinforce_max: '3',
  dict_online_enabled: '1',
};

export const INDEXES_EXTRA = [
  `CREATE INDEX IF NOT EXISTS ix_words_status ON words(translation_check_status)`,
];
