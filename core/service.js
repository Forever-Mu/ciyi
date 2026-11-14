/**
 * service.js —— 应用服务层
 *
 * 把 db / 解析 / 词典 / 核对 / 记忆算法 / 任务调度 串成完整业务流程。
 * 所有写操作都在事务里，保证意外退出不丢数据、不留半截状态。
 */

import { normalizeWord, splitSenses, extractPos, stripListNumber } from './text.js';
import { mergeRows } from './parse.js';
import { checkTranslation } from './checker.js';
import { applyAnswer, initialState, STATE, STATE_LABEL, isStudied } from './srs.js';
import {
  ensureDailyTasks, getPendingQueue, markTaskDone, enqueueReinforcement,
  summarizeDay, getSettings,
} from './scheduler.js';
import { today as todayStr, addDays, diffDays } from './time.js';

/* ================================================================
 *  导入
 * ================================================================ */

/**
 * 生成导入预览：批内去重 + 与库内已有词比对
 * @returns {{rows:Array, stats:object}}
 */
export function buildImportPreview(db, rawRows) {
  const { rows, duplicates } = mergeRows(rawRows);

  const preview = rows.map((r) => {
    const existing = db.get('SELECT * FROM words WHERE word=?', [r.key]);
    return {
      key: r.key,
      display: r.display,
      word: r.display,
      originalTranslation: r.translation,
      pos: r.pos,
      ukIpa: r.ukIpa,
      usIpa: r.usIpa,
      example: r.example,
      exampleTranslation: r.exampleTranslation,
      score: r.score,
      issues: r.issues,
      duplicateCount: r.duplicateCount,
      isExisting: !!existing,
      existingId: existing ? existing.id : null,
      existingTranslation: existing ? (existing.confirmed_translation || existing.original_translation) : null,
      keep: true,
    };
  });

  return {
    rows: preview,
    stats: {
      total: preview.length,
      newWords: preview.filter((r) => !r.isExisting).length,
      existingWords: preview.filter((r) => r.isExisting).length,
      duplicatesRemoved: duplicates,
      lowConfidence: preview.filter((r) => r.score < 0.7).length,
    },
  };
}

/**
 * 提交导入（事务）
 *
 * 重复单词的规则：
 *   · 已存在 -> 复用同一条 words 记录，学习记录天然保留
 *   · 原始释义永不覆盖；新释义按义项并集追加
 *   · 词性求并集
 */
export function commitImport(db, { name, sourceType, sourceName, rows }) {
  return db.transaction(() => {
    const now = todayStr();
    const listRes = db.run(
      `INSERT INTO word_lists(name, source_type, source_name, word_count, created_at)
       VALUES(?,?,?,?,?)`,
      [name || ('导入 ' + now), sourceType || 'paste', sourceName || '', 0, now]
    );
    const listId = listRes.lastId;

    let inserted = 0, updated = 0, linked = 0;

    for (const r of rows) {
      if (r.keep === false) continue;
      const key = normalizeWord(r.word || r.display);
      if (!key) continue;

      const existing = db.get('SELECT * FROM words WHERE word=?', [key]);
      let wordId;

      if (existing) {
        wordId = existing.id;
        // 原始释义保留；新义项并集追加
        const oldAtoms = splitSenses(existing.original_translation || '');
        const newAtoms = splitSenses(r.originalTranslation || '');
        for (const a of newAtoms) if (!oldAtoms.includes(a)) oldAtoms.push(a);

        const posOld = String(existing.part_of_speech || '').split(',').filter(Boolean);
        const posNew = (r.pos && r.pos.length ? r.pos : extractPos(r.originalTranslation || ''));
        const posAll = [...new Set([...posOld, ...posNew])];

        db.run(
          `UPDATE words SET
             original_translation=?, part_of_speech=?,
             uk_ipa=COALESCE(NULLIF(uk_ipa,''), ?),
             us_ipa=COALESCE(NULLIF(us_ipa,''), ?),
             english_example=COALESCE(NULLIF(english_example,''), ?),
             example_translation=COALESCE(NULLIF(example_translation,''), ?),
             updated_at=?
           WHERE id=?`,
          [oldAtoms.join('；'), posAll.join(','), r.ukIpa || '', r.usIpa || '',
            r.example || '', r.exampleTranslation || '', now, wordId]
        );
        updated++;
      } else {
        const posAll = r.pos && r.pos.length ? r.pos : extractPos(r.originalTranslation || '');
        const res = db.run(
          `INSERT INTO words(word, display_word, original_translation, part_of_speech,
                             uk_ipa, us_ipa, english_example, example_translation,
                             translation_check_status, created_at, updated_at)
           VALUES(?,?,?,?,?,?,?,?, 'pending', ?, ?)`,
          [key, (r.display || r.word || '').trim(), r.originalTranslation || '',
            posAll.join(','), r.ukIpa || '', r.usIpa || '', r.example || '',
            r.exampleTranslation || '', now, now]
        );
        wordId = res.lastId;
        inserted++;

        // 新词建立初始记忆状态
        const st = initialState();
        db.run(
          `INSERT OR IGNORE INTO review_schedule
             (word_id, state, ease, interval_days, repetitions, lapses,
              streak_correct, streak_wrong, total_answers, total_correct, total_wrong,
              difficulty, stability)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [wordId, st.state, st.ease, st.interval_days, st.repetitions, st.lapses,
            st.streak_correct, st.streak_wrong, st.total_answers, st.total_correct,
            st.total_wrong, st.difficulty, st.stability]
        );
      }

      const link = db.run(
        `INSERT OR IGNORE INTO word_list_items(list_id, word_id, raw_line) VALUES(?,?,?)`,
        [listId, wordId, r.raw || '']
      );
      if (link.changes) linked++;
    }

    db.run(`UPDATE word_lists SET word_count=? WHERE id=?`, [linked, listId]);

    return { ok: true, listId, inserted, updated, linked, total: rows.filter((r) => r.keep !== false).length };
  });
}

/**
 * 删除一个词库
 *
 * 之前的实现只删了「词库-单词」关系，单词本身留在 words 表里，
 * 于是这些词既不在任何词库里、又照样被统计和出题 —— 就是"孤儿单词"。
 * 现在默认把随之失去归属的单词一并删除（学习记录由外键级联清理）。
 *
 * @param {number} listId
 * @param {{removeOrphans?:boolean}} opts
 */
export function deleteWordList(db, listId, opts = {}) {
  const removeOrphans = opts.removeOrphans !== false;

  return db.transaction(() => {
    const ids = db
      .all('SELECT word_id FROM word_list_items WHERE list_id=?', [listId])
      .map((r) => r.word_id);

    db.run('DELETE FROM word_list_items WHERE list_id=?', [listId]);
    const r = db.run('DELETE FROM word_lists WHERE id=?', [listId]);

    let removedWords = 0;
    if (removeOrphans) {
      for (const id of ids) {
        const left = db.get('SELECT COUNT(*) AS c FROM word_list_items WHERE word_id=?', [id]);
        if (!left || left.c === 0) {
          db.run('DELETE FROM words WHERE id=?', [id]);   // 级联清掉记录/计划/任务
          removedWords++;
        }
      }
    }

    return { ok: true, removed: r.changes, removedWords };
  });
}

/**
 * 清理孤儿单词：不属于任何词库的单词
 *
 * 这些词在界面上不可达，却会计入词库总量、也会被排进学习任务。
 * 只在确实存在词库时才清理，避免"词库全删光了但又有一堆单词"这种异常状态下误删。
 *
 * @returns {{removed:number, remaining:number}}
 */
export function pruneOrphanWords(db) {
  return db.transaction(() => {
    const before = db.get('SELECT COUNT(*) AS c FROM words').c;
    const lists = db.get('SELECT COUNT(*) AS c FROM word_lists').c;

    if (lists === 0) {
      return { removed: 0, remaining: before, skipped: true };
    }

    const orphans = db.get(
      `SELECT COUNT(*) AS c FROM words w
        WHERE NOT EXISTS (SELECT 1 FROM word_list_items i WHERE i.word_id = w.id)`
    ).c;

    if (orphans > 0) {
      db.run(`DELETE FROM words
               WHERE NOT EXISTS (SELECT 1 FROM word_list_items i WHERE i.word_id = words.id)`);
    }

    const after = db.get('SELECT COUNT(*) AS c FROM words').c;
    return { removed: before - after, remaining: after };
  });
}

/**
 * 删除全部数据（保留设置）
 * 调用方必须做二次确认。
 */
export function deleteAllData(db) {
  return db.transaction(() => {
    const before = db.get('SELECT COUNT(*) AS c FROM words').c;
    db.run('DELETE FROM daily_tasks');
    db.run('DELETE FROM learning_records');
    db.run('DELETE FROM translation_check_records');
    db.run('DELETE FROM review_schedule');
    db.run('DELETE FROM word_list_items');
    db.run('DELETE FROM word_lists');
    db.run('DELETE FROM words');
    db.run('DELETE FROM daily_progress');
    db.run('DELETE FROM study_plan');
    return { ok: true, removedWords: before };
  });
}

/* ================================================================
 *  翻译核对
 * ================================================================ */

/**
 * 对一批单词做翻译核对（离线词典为主，可选在线补充）
 * @returns {{results:Array, report:object}}
 */
export async function checkWords(db, wordIds, dictService, opts = {}) {
  const allowOnline = opts.allowOnline !== false;
  const results = [];
  const report = { total: 0, A: 0, B: 0, C: 0, D: 0, E: 0, needsReview: 0, onlineErrors: 0 };

  for (const id of wordIds) {
    const w = db.get('SELECT * FROM words WHERE id=?', [id]);
    if (!w) continue;

    // 已核对过且不是强制，就跳过
    if (!opts.force && w.translation_check_status && w.translation_check_status !== 'pending') {
      continue;
    }

    const ref = dictService.reference(w.word);
    const declaredPos = String(w.part_of_speech || '').split(',').map((s) => s.trim()).filter(Boolean);
    const check = checkTranslation({
      word: w.word,
      originalTranslation: w.original_translation,
      declaredPos,
      reference: ref,
    });

    // 在线补充音标/例句（失败不影响核对结果）
    let enriched = null;
    if (allowOnline) {
      try {
        enriched = await dictService.enrich(
          { word: w.word, ukIpa: w.uk_ipa, usIpa: w.us_ipa, pos: declaredPos,
            example: w.english_example, exampleTranslation: w.example_translation },
          { allowOnline }
        );
        if (enriched.onlineError) report.onlineErrors++;
      } catch (e) {
        report.onlineErrors++;
      }
    }

    db.transaction(() => {
      db.run(
        `UPDATE words SET
           translation_check_status=?, translation_check_confidence=?,
           translation_check_reason=?, suggested_translation=?,
           uk_ipa=COALESCE(NULLIF(?,''), uk_ipa),
           us_ipa=COALESCE(NULLIF(?,''), us_ipa),
           english_example=COALESCE(NULLIF(english_example,''), NULLIF(?,'')),
           dictionary_data=?, updated_at=?
         WHERE id=?`,
        [check.status, check.confidence, check.reason, check.suggested || '',
          (enriched && enriched.ukIpa) || '', (enriched && enriched.usIpa) || '',
          (enriched && enriched.englishExample) || '',
          enriched && enriched.online ? JSON.stringify(enriched.online).slice(0, 20000) : '',
          todayStr(), id]
      );

      db.run(
        `INSERT INTO translation_check_records
           (word_id, batch_id, original_translation, dictionary_reference,
            suggested_translation, status, confidence, reason, sources, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [id, opts.batchId || '', w.original_translation || '',
          (check.details && check.details.refSenses || []).join('；'),
          check.suggested || '', check.status, check.confidence, check.reason,
          (check.sources || []).join(','), todayStr()]
      );
    });

    report.total++;
    if (report[check.status] !== undefined) report[check.status]++;
    if (check.status !== 'A') report.needsReview++;

    results.push({ wordId: id, word: w.word, ...check });
  }

  return { results, report };
}

/**
 * 用户对核对结果的处理
 * @param {'keep'|'adopt'|'manual'|'skip'} action
 */
export function applyCheckDecision(db, wordId, action, manualText) {
  return db.transaction(() => {
    const w = db.get('SELECT * FROM words WHERE id=?', [wordId]);
    if (!w) return { ok: false, error: '单词不存在' };

    let confirmed = w.confirmed_translation;

    if (action === 'keep') {
      confirmed = null;                       // 视为确认使用原始释义
    } else if (action === 'adopt') {
      confirmed = w.suggested_translation || '';
      if (!confirmed) return { ok: false, error: '没有可采用的推荐释义' };
    } else if (action === 'manual') {
      confirmed = String(manualText || '').trim();
      if (!confirmed) return { ok: false, error: '手工释义不能为空' };
    } else if (action === 'skip') {
      // 暂不处理
    } else {
      return { ok: false, error: '未知操作' };
    }

    db.run(
      `UPDATE words SET confirmed_translation=?, translation_check_status=?, updated_at=? WHERE id=?`,
      [confirmed, action === 'skip' ? w.translation_check_status : 'confirmed', todayStr(), wordId]
    );

    db.run(
      `UPDATE translation_check_records SET user_action=?
        WHERE id = (SELECT id FROM translation_check_records WHERE word_id=?
                     ORDER BY id DESC LIMIT 1)`,
      [action, wordId]
    );

    return { ok: true, confirmedTranslation: confirmed };
  });
}

/* ================================================================
 *  答题
 * ================================================================ */

/**
 * 记录一次答题，并推进记忆状态与任务状态
 *
 * @param {object} p
 * @param {number} p.wordId
 * @param {string} p.mode        new | reinforce | review
 * @param {string} p.questionType
 * @param {boolean} p.isCorrect
 * @param {string} [p.userAnswer]
 * @param {number} [p.taskId]    对应的 daily_tasks.id，答完即标记 done
 * @param {string} [p.date]
 */
export function recordAnswer(db, p) {
  const date = p.date || todayStr();
  const wordId = p.wordId;

  return db.transaction(() => {
    const rsRow = db.get('SELECT * FROM review_schedule WHERE word_id=?', [wordId]);
    const state = rsRow || { ...initialState(), word_id: wordId };

    // 当天第一次作答？
    const priorRow = db.get(
      'SELECT COUNT(*) AS c FROM learning_records WHERE word_id=? AND local_date=?',
      [wordId, date]
    );
    const isFirstOfDay = !priorRow || priorRow.c === 0;

    const next = applyAnswer(state, {
      isCorrect: p.isCorrect,
      mode: p.mode || 'new',
      isFirstOfDay,
      localDate: date,
    });

    // 落库：记忆状态
    if (rsRow) {
      db.run(
        `UPDATE review_schedule SET
           state=?, ease=?, interval_days=?, repetitions=?, lapses=?,
           streak_correct=?, streak_wrong=?, total_answers=?, total_correct=?, total_wrong=?,
           difficulty=?, stability=?, first_studied_at=?, last_studied_at=?,
           last_reviewed_at=?, due_at=?
         WHERE word_id=?`,
        [next.state, next.ease, next.interval_days, next.repetitions, next.lapses,
          next.streak_correct, next.streak_wrong, next.total_answers, next.total_correct,
          next.total_wrong, next.difficulty, next.stability, next.first_studied_at,
          next.last_studied_at, next.last_reviewed_at, next.due_at, wordId]
      );
    } else {
      db.run(
        `INSERT INTO review_schedule
           (word_id, state, ease, interval_days, repetitions, lapses,
            streak_correct, streak_wrong, total_answers, total_correct, total_wrong,
            difficulty, stability, first_studied_at, last_studied_at, last_reviewed_at, due_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [wordId, next.state, next.ease, next.interval_days, next.repetitions, next.lapses,
          next.streak_correct, next.streak_wrong, next.total_answers, next.total_correct,
          next.total_wrong, next.difficulty, next.stability, next.first_studied_at,
          next.last_studied_at, next.last_reviewed_at, next.due_at]
      );
    }

    // 落库：答题流水
    db.run(
      `INSERT INTO learning_records
         (word_id, mode, question_type, is_correct, user_answer, is_first_of_day, local_date, created_at)
       VALUES(?,?,?,?,?,?,?,?)`,
      [wordId, p.mode || 'new', p.questionType || 'en2cn', p.isCorrect ? 1 : 0,
        String(p.userAnswer == null ? '' : p.userAnswer).slice(0, 200),
        isFirstOfDay ? 1 : 0, date, date]
    );

    // 任务完成
    if (p.taskId) markTaskDone(db, p.taskId, date);

    // 答错 -> 安排当天强化（受上限约束）
    let queued = false;
    if (!p.isCorrect) {
      const maxRe = Number(getSettings(db).reinforce_max) || 3;
      queued = enqueueReinforcement(db, date, wordId, maxRe);
    }

    db.run(
      `INSERT INTO daily_progress(local_date, new_target, total_answers, correct_answers, updated_at)
       VALUES(?,?,?,?,?)
       ON CONFLICT(local_date) DO UPDATE SET
         total_answers = total_answers + 1,
         correct_answers = correct_answers + ?,
         updated_at = excluded.updated_at`,
      [date, 50, 1, p.isCorrect ? 1 : 0, date, p.isCorrect ? 1 : 0]
    );

    return {
      ok: true,
      state: next,
      stateLabel: STATE_LABEL[next.state] || next.state,
      isFirstOfDay,
      reinforceQueued: queued,
    };
  });
}

/* ================================================================
 *  查询 / 统计
 * ================================================================ */

export function getHomeData(db, date = todayStr()) {
  const day = ensureDailyTasks(db, date);
  const all = db.get('SELECT COUNT(*) AS c FROM words');
  const pending = getPendingQueue(db, date);

  return {
    date,
    day,
    totalWords: all ? all.c : 0,
    nextItem: pending.length ? pending[0] : null,
    pendingCount: pending.length,
  };
}

/** 词库页：搜索 / 筛选 / 分页 */
export function searchWords(db, opts = {}) {
  const where = [];
  const params = [];

  if (opts.q) {
    where.push('(w.word LIKE ? OR w.original_translation LIKE ? OR w.confirmed_translation LIKE ?)');
    const like = '%' + opts.q + '%';
    params.push(like, like, like);
  }
  if (opts.listId) {
    where.push('EXISTS (SELECT 1 FROM word_list_items i WHERE i.word_id=w.id AND i.list_id=?)');
    params.push(opts.listId);
  }
  if (opts.state && opts.state !== 'all') {
    if (opts.state === 'new') {
      where.push(`(rs.word_id IS NULL OR rs.state='new')`);
    } else {
      where.push('rs.state = ?');
      params.push(opts.state);
    }
  }
  if (opts.letter) {
    where.push('LOWER(w.word) LIKE ?');
    params.push(opts.letter.toLowerCase() + '%');
  }

  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.get(
    `SELECT COUNT(*) AS c FROM words w LEFT JOIN review_schedule rs ON rs.word_id=w.id ${clause}`,
    params
  );

  const limit = Math.min(opts.limit || 50, 200);
  const offset = opts.offset || 0;

  const rows = db.all(
    `SELECT w.*, rs.state, rs.due_at, rs.total_wrong, rs.total_answers, rs.ease,
            rs.interval_days, rs.repetitions
       FROM words w
       LEFT JOIN review_schedule rs ON rs.word_id=w.id
       ${clause}
      ORDER BY w.word ASC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return { total: total ? total.c : 0, rows, limit, offset };
}

export function getStats(db) {
  const total = db.get('SELECT COUNT(*) AS c FROM words').c;
  const byState = {};
  for (const s of Object.values(STATE)) byState[s] = 0;

  const stateRows = db.all('SELECT state, COUNT(*) AS c FROM review_schedule GROUP BY state');
  for (const r of stateRows) byState[r.state] = r.c;
  // 没有 review_schedule 行的词也算未学习
  const noSchedule = db.get(
    `SELECT COUNT(*) AS c FROM words w LEFT JOIN review_schedule rs ON rs.word_id=w.id
      WHERE rs.word_id IS NULL`
  ).c;
  byState.new = (byState.new || 0) + noSchedule;

  const studied = total - byState.new;
  const ans = db.get('SELECT COUNT(*) AS c, SUM(is_correct) AS ok FROM learning_records');
  const totalAnswers = ans && ans.c ? ans.c : 0;
  const correctAnswers = ans && ans.ok ? ans.ok : 0;

  const trend = db.all(
    `SELECT local_date AS date,
            COUNT(*) AS answers,
            SUM(is_correct) AS correct,
            COUNT(DISTINCT word_id) AS words
       FROM learning_records
      WHERE local_date >= ?
      GROUP BY local_date
      ORDER BY local_date ASC`,
    [addDays(todayStr(), -13)]
  );

  return {
    totalWords: total,
    studied,
    mastered: byState.mastered || 0,
    consolidating: byState.consolidating || 0,
    learning: byState.learning || 0,
    fragile: byState.fragile || 0,
    newWords: byState.new || 0,
    totalAnswers,
    correctAnswers,
    wrongAnswers: totalAnswers - correctAnswers,
    accuracy: totalAnswers ? Math.round((correctAnswers / totalAnswers) * 1000) / 10 : 0,
    trend,
  };
}

/** 词库列表 */
export function listWordLists(db) {
  return db.all(
    `SELECT l.*, (SELECT COUNT(*) FROM word_list_items i WHERE i.list_id=l.id) AS actual_count
       FROM word_lists l ORDER BY l.id DESC`
  );
}

/** 删除单词（连同学习记录，事务保护） */
export function deleteWord(db, wordId) {
  return db.transaction(() => {
    const r = db.run('DELETE FROM words WHERE id=?', [wordId]);
    return { ok: true, removed: r.changes };
  });
}

/** 手工修改单词资料 */
export function updateWord(db, wordId, patch) {
  const allowed = ['original_translation', 'confirmed_translation', 'part_of_speech',
    'uk_ipa', 'us_ipa', 'english_example', 'example_translation'];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (patch[k] !== undefined) { sets.push(`${k}=?`); params.push(patch[k]); }
  }
  if (!sets.length) return { ok: false, error: '没有要修改的字段' };
  sets.push('updated_at=?');
  params.push(todayStr(), wordId);
  db.run(`UPDATE words SET ${sets.join(',')} WHERE id=?`, params);
  return { ok: true };
}

/**
 * 修复历史数据：早期版本会把行首编号一起当成单词存下来
 * （"10 exceptional" 而不是 "exceptional"）。
 * 启动时跑一次，把能改的改回来；和目标单词已存在冲突的留给用户处理。
 *
 * @returns {{fixed:number, skipped:number}}
 */
export function repairNumberedWords(db) {
  return db.transaction(() => {
    const candidates = db.all(
      `SELECT id, word, display_word FROM words WHERE word GLOB '[0-9]*'`
    );
    let fixed = 0;
    let skipped = 0;

    for (const w of candidates) {
      const cleanWord = normalizeWord(stripListNumber(w.word));
      if (!cleanWord || cleanWord === w.word) continue;
      if (!/^[A-Za-z]/.test(cleanWord)) continue;      // 剥完不是英文就别动

      const clash = db.get('SELECT id FROM words WHERE word=? AND id<>?', [cleanWord, w.id]);
      if (clash) { skipped++; continue; }              // 已存在同名词，不自动合并

      const cleanDisplay = stripListNumber(w.display_word || w.word) || cleanWord;
      db.run(
        `UPDATE words SET word=?, display_word=?, updated_at=? WHERE id=?`,
        [cleanWord, cleanDisplay, todayStr(), w.id]
      );
      fixed++;
    }
    return { fixed, skipped };
  });
}
