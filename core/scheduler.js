/**
 * scheduler.js —— 每日任务调度
 *
 * 规则（对应需求 6 / 9.4 / 10）：
 *
 *   1. 每天默认 50 个**新词**任务（可在设置修改）
 *   2. 昨天没做完的新词必须继承到今天，且占用今天的名额
 *        例：昨天剩 15 -> 今天 = 15 继承 + 35 新词 = 50
 *   3. 继承任务超过 50 时，先安排最早产生的
 *   4. 每日任务只生成一次，重复打开 App 不会重新洗牌
 *   5. 旧词复习不占新词名额，按到期与错误历史自动排优先级
 *   6. 当天答错的词进入强化队列，在后续位置重新出现（不立刻重考）
 */

import { today as todayStr, addDays, diffDays } from './time.js';
import { reviewPriority, STATE } from './srs.js';

export const DEFAULT_NEW_TARGET = 50;
export const REINFORCE_GAP = 3;        // 强化题插到后面第 3 个位置

const REVIEW_BASE_POS = 100000;        // 复习任务的位置基数，排在新词之后

function getSetting(db, key, fallback) {
  const row = db.get('SELECT value FROM app_settings WHERE key=?', [key]);
  if (!row) return fallback;
  const n = Number(row.value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 读取全部设置 */
export function getSettings(db) {
  const rows = db.all('SELECT key,value FROM app_settings');
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function setSetting(db, key, value) {
  db.run(`INSERT INTO app_settings(key,value) VALUES(?,?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [key, String(value)]);
}

/** 某天是否已经生成过任务 */
export function hasTasksFor(db, date) {
  const row = db.get('SELECT COUNT(*) AS c FROM daily_tasks WHERE local_date=?', [date]);
  return row && row.c > 0;
}

/* ================================================================
 *  学习计划
 *
 *  设计意图：任务不再是"打开 App 就自动出现的"，而是由用户主动开启一个计划。
 *  开始之后每天自动排，不用每天再点一次。
 * ================================================================ */

/** 未学习、且**有中文释义**的词（没有释义的词不能出题，不能计入计划） */
export function countUnlearnedWords(db) {
  const row = db.get(
    `SELECT COUNT(*) AS c
       FROM words w
       LEFT JOIN review_schedule rs ON rs.word_id = w.id
      WHERE (rs.word_id IS NULL OR rs.state = 'new')
        AND TRIM(COALESCE(
              NULLIF(w.confirmed_translation, ''),
              NULLIF(w.original_translation, ''),
              NULLIF(w.suggested_translation, ''), '')) <> ''`
  );
  return row ? row.c : 0;
}

/** 取当前进行中的计划 */
export function getActivePlan(db) {
  return db.get(`SELECT * FROM study_plan WHERE status='active' ORDER BY id DESC LIMIT 1`) || null;
}

/**
 * 估算：按每天 N 词，多久能背完
 * @returns {{unlearned:number, perDay:number, days:number, finishDate:string, startDate:string}}
 */
export function estimatePlan(db, perDay, startDate = todayStr()) {
  const unlearned = countUnlearnedWords(db);
  const per = Math.max(1, Math.floor(Number(perDay) || DEFAULT_NEW_TARGET));
  const days = unlearned > 0 ? Math.ceil(unlearned / per) : 0;
  return {
    unlearned,
    perDay: per,
    days,
    startDate,
    finishDate: days > 0 ? addDays(startDate, days - 1) : startDate,
  };
}

/** 计划进度：已学词数（按 first_studied_at 落在计划开始之后统计） */
export function planProgress(db, date = todayStr()) {
  const plan = getActivePlan(db);
  if (!plan) return null;

  const row = db.get(
    `SELECT COUNT(*) AS c FROM review_schedule
      WHERE first_studied_at IS NOT NULL AND first_studied_at >= ?`,
    [plan.started_at]
  );
  const learned = Math.min(plan.target_words, row ? row.c : 0);
  const remaining = Math.max(0, plan.target_words - learned);
  const plannedDays = plan.words_per_day > 0
    ? Math.ceil(plan.target_words / plan.words_per_day) : 0;
  const rawDay = diffDays(plan.started_at, date) + 1;
  // 计划可能提前学完，天数不要超过计划总天数，否则会出现"第 4 天 / 共 2 天"
  const dayIndex = plannedDays > 0 ? Math.min(plannedDays, Math.max(1, rawDay)) : Math.max(1, rawDay);

  return {
    plan,
    learned,
    remaining,
    target: plan.target_words,
    percent: plan.target_words > 0 ? Math.round((learned / plan.target_words) * 100) : 0,
    dayIndex,
    plannedDays,
    finishDate: plannedDays > 0 ? addDays(plan.started_at, plannedDays - 1) : plan.started_at,
    spellingEnabled: plan.spelling_enabled === 1,
  };
}

/**
 * 开始一个新计划（旧的 active 计划会被置为 cancelled）
 * @param {object} opts { wordsPerDay, spellingEnabled, date }
 */
export function startPlan(db, opts = {}) {
  const date = opts.date || todayStr();
  const perDay = Math.max(1, Math.min(500, Math.floor(Number(opts.wordsPerDay) || DEFAULT_NEW_TARGET)));
  const spell = opts.spellingEnabled !== false;
  const unlearned = countUnlearnedWords(db);

  return db.transaction(() => {
    db.run(`UPDATE study_plan SET status='cancelled' WHERE status='active'`);
    // 同一时间的今天是唯一键约束的例外：直接重建当天的未完成任务
    const res = db.run(
      `INSERT INTO study_plan(started_at, words_per_day, target_words, spelling_enabled,
                              status, created_at)
       VALUES(?,?,?,?, 'active', ?)`,
      [date, perDay, unlearned, spell ? 1 : 0, date]
    );
    // 计划参数与设置保持同步，避免两处数字打架
    setSetting(db, 'daily_new_target', perDay);
    setSetting(db, 'spelling_enabled', spell ? '1' : '0');
    return { ok: true, planId: res.lastId, targetWords: unlearned, wordsPerDay: perDay };
  });
}

/** 结束当前计划（到期复习仍会继续） */
export function cancelPlan(db, date = todayStr()) {
  return db.transaction(() => {
    const r = db.run(
      `UPDATE study_plan SET status='cancelled', finished_at=? WHERE status='active'`,
      [date]
    );
    return { ok: true, cancelled: r.changes };
  });
}

/**
 * 把已经背完的计划标记为 finished
 * @returns {boolean} 是否本次被标记完成
 */
export function closePlanIfDone(db, date = todayStr()) {
  const plan = getActivePlan(db);
  if (!plan) return false;
  const p = planProgress(db);
  if (!p) return false;
  if (p.remaining > 0) return false;
  db.run(`UPDATE study_plan SET status='finished', finished_at=? WHERE id=?`, [date, plan.id]);
  return true;
}

/**
 * 旧版本兼容：以前没有计划概念，老用户直接就有学习记录。
 * 如果发现有学习记录却没有任何计划，自动补一个，避免升级后突然没任务。
 */
export function migrateLegacyPlan(db, date = todayStr()) {
  const any = db.get(`SELECT COUNT(*) AS c FROM study_plan`);
  if (any && any.c > 0) return false;

  const studied = db.get(
    `SELECT COUNT(*) AS c FROM review_schedule WHERE total_answers > 0`
  );
  if (!studied || studied.c === 0) return false;

  const perDay = getSetting(db, 'daily_new_target', DEFAULT_NEW_TARGET);
  db.run(
    `INSERT INTO study_plan(started_at, words_per_day, target_words, spelling_enabled,
                            status, created_at)
     VALUES(?,?,?,?, 'active', ?)`,
    [date, perDay, countUnlearnedWords(db), 1, date]
  );
  return true;
}

/**
 * 生成（或读取已有的）当天任务
 *
 * @param {object} db
 * @param {string} date  本地日期
 * @returns {{date, created, newCount, carriedCount, reviewCount}}
 */
export function ensureDailyTasks(db, date = todayStr()) {
  if (hasTasksFor(db, date)) {
    return summarizeDay(db, date);
  }

  // 老用户升级兼容：有学习记录但没有计划的话补一个，避免升级后突然没任务
  migrateLegacyPlan(db, date);

  const plan = getActivePlan(db);
  const target = plan
    ? Math.max(1, plan.words_per_day)
    : getSetting(db, 'daily_new_target', DEFAULT_NEW_TARGET);

  return db.transaction(() => {
    let pos = 0;
    const takenWordIds = new Set();

    // ---------- 1) 继承以前没做完的新词 ----------
    // 没有计划时不再继承，未完成的词留到下次开计划时再用
    const carried = plan
      ? db.all(
          `SELECT * FROM daily_tasks
           WHERE kind='new' AND status='pending' AND local_date < ?
           ORDER BY COALESCE(origin_date, local_date) ASC, local_date ASC, position ASC`,
          [date]
        )
      : [];

    const carriedTake = carried.slice(0, target);

    // 旧任务标记为已结转，避免被反复继承 / 重复计数
    for (const t of carried) {
      db.run(`UPDATE daily_tasks SET status='carried' WHERE id=?`, [t.id]);
    }

    for (const t of carriedTake) {
      db.run(
        `INSERT OR IGNORE INTO daily_tasks
           (local_date, kind, word_id, position, status, is_carryover, origin_date, created_at)
         VALUES (?,?,?,?, 'pending', 1, ?, ?)`,
        [date, 'new', t.word_id, pos++, t.origin_date || t.local_date, date]
      );
      takenWordIds.add(t.word_id);
    }

    // ---------- 2) 用未学过的词补足到目标数 ----------
    // 注意：
    //   · 没有中文释义的词不进任务队列 —— 否则会出一道没有答案的废题。
    //     它们会在词库里显示为「无释义」，由用户补全或删除。
    //   · 没有进行中的计划时，一个新词都不排（必须由用户主动开始计划）。
    const need = plan ? target - carriedTake.length : 0;
    let added = 0;
    if (need > 0) {
      const unlearned = db.all(
        `SELECT w.id
           FROM words w
           LEFT JOIN review_schedule rs ON rs.word_id = w.id
          WHERE (rs.word_id IS NULL OR rs.state = 'new')
            AND TRIM(COALESCE(
                  NULLIF(w.confirmed_translation, ''),
                  NULLIF(w.original_translation, ''),
                  NULLIF(w.suggested_translation, ''), '')) <> ''
          ORDER BY w.id ASC`
      );
      for (const row of unlearned) {
        if (added >= need) break;
        if (takenWordIds.has(row.id)) continue;
        db.run(
          `INSERT OR IGNORE INTO daily_tasks
             (local_date, kind, word_id, position, status, is_carryover, origin_date, created_at)
           VALUES (?,?,?,?, 'pending', 0, ?, ?)`,
          [date, 'new', row.id, pos++, date, date]
        );
        takenWordIds.add(row.id);
        added++;
      }
    }

    // ---------- 3) 到期旧词复习 ----------
    const dueRows = db.all(
      `SELECT rs.*, w.id AS wid
         FROM review_schedule rs
         JOIN words w ON w.id = rs.word_id
        WHERE rs.state <> 'new'
          AND rs.due_at IS NOT NULL
          AND rs.due_at <= ?`,
      [date]
    );

    const ranked = dueRows
      .filter((r) => !takenWordIds.has(r.wid))       // 今天已作为新词出现的先不重复
      .map((r) => ({ r, p: reviewPriority(r, date) }))
      .sort((a, b) => b.p - a.p || String(a.r.due_at).localeCompare(String(b.r.due_at)));

    let rpos = REVIEW_BASE_POS;
    for (const { r } of ranked) {
      db.run(
        `INSERT OR IGNORE INTO daily_tasks
           (local_date, kind, word_id, position, status, is_carryover, origin_date, created_at)
         VALUES (?,?,?,?, 'pending', 0, ?, ?)`,
        [date, 'review', r.wid, rpos++, date, date]
      );
    }

    // ---------- 4) 当天进度记录 ----------
    db.run(
      `INSERT INTO daily_progress(local_date, new_target, updated_at)
       VALUES(?,?,?)
       ON CONFLICT(local_date) DO UPDATE SET new_target=excluded.new_target, updated_at=excluded.updated_at`,
      [date, target, date]
    );

    return summarizeDay(db, date);
  });
}

/** 汇总某天的任务情况 */
export function summarizeDay(db, date) {
  const rows = db.all(
    `SELECT kind, status, COUNT(*) AS c FROM daily_tasks WHERE local_date=? GROUP BY kind, status`,
    [date]
  );
  const agg = {};
  for (const r of rows) {
    agg[r.kind] = agg[r.kind] || { pending: 0, done: 0, carried: 0 };
    agg[r.kind][r.status] = r.c;
  }

  const nw = agg.new || { pending: 0, done: 0 };
  const rv = agg.review || { pending: 0, done: 0 };
  const rf = agg.reinforce || { pending: 0, done: 0 };

  const carriedRow = db.get(
    `SELECT COUNT(*) AS c FROM daily_tasks WHERE local_date=? AND kind='new' AND is_carryover=1`,
    [date]
  );

  const plan = getActivePlan(db);
  const target = plan
    ? Math.max(1, plan.words_per_day)
    : getSetting(db, 'daily_new_target', DEFAULT_NEW_TARGET);

  return {
    date,
    created: true,
    hasPlan: !!plan,
    spellingEnabled: plan ? plan.spelling_enabled === 1 : getSetting(db, 'spelling_enabled', 1) !== 0,
    newTarget: target,
    newTotal: (nw.pending || 0) + (nw.done || 0),
    newDone: nw.done || 0,
    newLeft: nw.pending || 0,
    carriedCount: carriedRow ? carriedRow.c : 0,
    reviewTotal: (rv.pending || 0) + (rv.done || 0),
    reviewDone: rv.done || 0,
    reviewLeft: rv.pending || 0,
    reinforceLeft: rf.pending || 0,
  };
}

/**
 * 取当天待办队列（按 position 升序）
 * 每次答题后重新取，天然支持"答错后插到后面重考"
 */
export function getPendingQueue(db, date = todayStr()) {
  return db.all(
    `SELECT t.id AS task_id, t.kind, t.position, t.is_carryover, t.origin_date,
            w.id AS word_id, w.word, w.display_word, w.original_translation,
            w.confirmed_translation, w.part_of_speech, w.uk_ipa, w.us_ipa,
            w.english_example, w.example_translation,
            rs.state, rs.ease, rs.interval_days, rs.repetitions, rs.total_wrong,
            rs.due_at
       FROM daily_tasks t
       JOIN words w ON w.id = t.word_id
       LEFT JOIN review_schedule rs ON rs.word_id = w.id
      WHERE t.local_date = ? AND t.status = 'pending'
      ORDER BY t.position ASC`,
    [date]
  );
}

/** 标记任务完成 */
export function markTaskDone(db, taskId, date = todayStr()) {
  db.run(`UPDATE daily_tasks SET status='done', completed_at=? WHERE id=?`, [date, taskId]);
  db.run(`UPDATE daily_progress SET
            new_done = (SELECT COUNT(*) FROM daily_tasks WHERE local_date=? AND kind='new' AND status='done'),
            review_done = (SELECT COUNT(*) FROM daily_tasks WHERE local_date=? AND kind='review' AND status='done'),
            reinforce_done = (SELECT COUNT(*) FROM daily_tasks WHERE local_date=? AND kind='reinforce' AND status='done'),
            updated_at = ?
          WHERE local_date=?`, [date, date, date, date, date]);
}

/**
 * 答错后把该词重新排进当天队列
 * 同一词同一天最多安排 maxTimes 轮（round 递增，不受唯一约束限制）
 * @returns {boolean} 是否成功排队
 */
export function enqueueReinforcement(db, date, wordId, maxTimes) {
  const done = db.get(
    `SELECT COUNT(*) AS c FROM daily_tasks
      WHERE local_date=? AND kind='reinforce' AND word_id=?`,
    [date, wordId]
  );
  const used = done ? done.c : 0;
  const limit = maxTimes || 3;
  if (used >= limit) return false;

  // 队列里还有未做的强化题，就不重复插入（等它先被答掉）
  const pendingRow = db.get(
    `SELECT id FROM daily_tasks
      WHERE local_date=? AND kind='reinforce' AND word_id=? AND status='pending'`,
    [date, wordId]
  );
  if (pendingRow) return true;

  const maxRow = db.get(
    `SELECT COALESCE(MAX(position), 0) AS m FROM daily_tasks WHERE local_date=?`, [date]
  );
  let pos = (maxRow ? maxRow.m : 0) + REINFORCE_GAP;
  if (pos < 50) pos = 50 + used * REINFORCE_GAP;

  db.run(
    `INSERT INTO daily_tasks
       (local_date, kind, word_id, position, status, is_carryover, origin_date, round, created_at)
     VALUES(?,?,?,?, 'pending', 0, ?, ?, ?)`,
    [date, 'reinforce', wordId, pos, date, used + 1, date]
  );
  return true;
}

/** 某天已经排过几次强化 */
export function reinforcementCount(db, date, wordId) {
  const r = db.get(
    `SELECT COUNT(*) AS c FROM daily_tasks WHERE local_date=? AND kind='reinforce' AND word_id=?`,
    [date, wordId]
  );
  return r ? r.c : 0;
}

/** 清理：把未来日期误建的任务删掉（数据修复用） */
export function purgeFutureTasks(db, date = todayStr()) {
  db.run(`DELETE FROM daily_tasks WHERE local_date > ?`, [date]);
}
