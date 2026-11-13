/**
 * srs.js —— 自适应间隔重复算法（SM-2 风格）
 *
 * 纯函数：输入当前记忆状态 + 一次答题事件，输出新状态。不碰数据库，便于测试。
 *
 * 核心规则（对应需求 9.2 / 9.3）：
 *
 *   初始 ease 2.3，范围 1.3 ~ 2.6
 *   首次学习后           -> 1 天后复习
 *   第 1 次正式复习答对   -> 3 天
 *   第 2 次正式复习答对   -> 7 天
 *   第 3 次及以后         -> 上次间隔 × ease，上限 365
 *   答错                 -> 连续对归零、lapses+1、ease-0.2(下限1.3)、1 天后重来、标记 fragile
 *
 * 关键分离：**当天重复强化不改长期间隔**。
 * 只有「当天第一次独立作答」对正式复习才生效 —— 否则今天答错两次、
 * 第三次蒙对，就会被错误地推到 7 天后。
 */

import { addDays, diffDays } from './time.js';

export const EASE_INIT = 2.3;
export const EASE_MIN = 1.3;
export const EASE_MAX = 2.6;
export const MAX_INTERVAL = 365;
export const MASTER_INTERVAL = 21;   // 间隔达到 21 天视为已掌握

export const STATE = {
  NEW: 'new',
  LEARNING: 'learning',
  CONSOLIDATING: 'consolidating',
  MASTERED: 'mastered',
  FRAGILE: 'fragile',
};

export const STATE_LABEL = {
  new: '未学习',
  learning: '正在学习',
  consolidating: '待巩固',
  mastered: '已掌握',
  fragile: '容易遗忘',
};

/** 新词的初始记忆状态 */
export function initialState() {
  return {
    state: STATE.NEW,
    ease: EASE_INIT,
    interval_days: 0,
    repetitions: 0,
    lapses: 0,
    streak_correct: 0,
    streak_wrong: 0,
    total_answers: 0,
    total_correct: 0,
    total_wrong: 0,
    difficulty: 0.5,
    stability: 1,
    first_studied_at: null,
    last_studied_at: null,
    last_reviewed_at: null,
    due_at: null,
  };
}

/** 由 ease 换算难度（0~1，越大越难） */
function easeToDifficulty(ease) {
  return Math.max(0, Math.min(1, (EASE_MAX - ease) / (EASE_MAX - EASE_MIN)));
}

/**
 * 派生记忆状态
 * @param {object} s
 * @param {boolean} lastCorrect 本次作答是否正确（决定"当前是否处于遗忘态"）
 */
function deriveState(s, lastCorrect) {
  if (s.total_answers === 0) return STATE.NEW;

  // 刚答错、且这个词已经进入过长期记忆 -> 判定为易忘
  // （初次学习就答错不算"容易遗忘"，那只是还没学会）
  if (lastCorrect === false && (s.lapses >= 1 || s.streak_wrong >= 2)) return STATE.FRAGILE;

  const acc = s.total_answers > 0 ? s.total_correct / s.total_answers : 1;
  if (s.lapses >= 3 || (s.total_wrong >= 3 && acc < 0.5)) return STATE.FRAGILE;

  if (s.interval_days >= MASTER_INTERVAL) return STATE.MASTERED;
  if (s.repetitions >= 2) return STATE.CONSOLIDATING;
  return STATE.LEARNING;
}

/**
 * 计算下一次长期间隔
 * @param {number} prevInterval 上次间隔（天）
 * @param {number} repetitions  本次答对后累计的连续成功次数（已 +1）
 * @param {number} ease
 */
export function nextInterval(prevInterval, repetitions, ease) {
  let v;
  if (repetitions === 1) v = 3;
  else if (repetitions === 2) v = 7;
  else v = Math.round(Math.max(1, prevInterval) * ease);

  v = Math.round(v);
  if (!Number.isFinite(v) || v < 1) v = 1;
  return Math.min(v, MAX_INTERVAL);
}

/**
 * 应用一次答题
 *
 * @param {object} state   当前记忆状态（review_schedule 行，可以是 initialState()）
 * @param {object} event
 * @param {boolean} event.isCorrect
 * @param {'new'|'reinforce'|'review'} event.mode
 * @param {boolean} [event.isFirstOfDay] 是否当天第一次作答该词
 * @param {string}  event.localDate      本地日期 YYYY-MM-DD
 * @returns {object} 新状态（不修改入参）
 */
export function applyAnswer(state, event) {
  const s = { ...initialState(), ...state };
  const today = event.localDate;
  const correct = !!event.isCorrect;
  const mode = event.mode || 'new';
  const firstOfDay = event.isFirstOfDay !== false;

  s.total_answers += 1;
  if (correct) s.total_correct += 1;
  else s.total_wrong += 1;

  if (correct) {
    s.streak_correct += 1;
    s.streak_wrong = 0;
  } else {
    s.streak_wrong += 1;
    s.streak_correct = 0;
  }

  s.last_studied_at = today;
  if (!s.first_studied_at) s.first_studied_at = today;

  if (mode === 'new') {
    // 首次学习：安排明天第一次长期复习。答错也安排明天（要先记住才能谈间隔）。
    s.state = correct ? STATE.LEARNING : STATE.LEARNING;
    s.repetitions = 0;                 // 还不算"正式复习成功"
    s.interval_days = 1;
    s.due_at = addDays(today, 1);
    s.ease = EASE_INIT;
  } else if (mode === 'reinforce') {
    // 当天强化：只更新计数，不动长期间隔
    // 当天再次答错 -> 更容易忘
    if (!correct) {
      s.ease = Math.max(EASE_MIN, Math.round((s.ease - 0.1) * 100) / 100);
    }
  } else if (mode === 'review') {
    if (firstOfDay) {
      // 只有当天第一次独立作答才推进长期间隔
      if (correct) {
        s.repetitions += 1;
        s.interval_days = nextInterval(s.interval_days, s.repetitions, s.ease);
        s.ease = Math.min(EASE_MAX, Math.round((s.ease + 0.05) * 100) / 100);
        s.due_at = addDays(today, s.interval_days);
        s.last_reviewed_at = today;
      } else {
        s.lapses += 1;
        s.repetitions = 0;
        s.ease = Math.max(EASE_MIN, Math.round((s.ease - 0.2) * 100) / 100);
        s.interval_days = 1;
        s.due_at = addDays(today, 1);
        s.last_reviewed_at = today;
      }
    } else {
      // 当天重复：不动间隔，只按错误微调难度
      if (!correct) {
        s.ease = Math.max(EASE_MIN, Math.round((s.ease - 0.1) * 100) / 100);
      }
    }
  }

  s.difficulty = Math.round(easeToDifficulty(s.ease) * 100) / 100;
  s.stability = s.interval_days || 1;
  s.state = deriveState(s, correct);
  return s;
}

/**
 * 复习优先级分数：越大越该先复习
 * 综合考虑逾期程度、累计错误、连续错误、正确率、难度
 *
 * @param {object} row review_schedule 行（含 total_wrong / ease / due_at ...）
 * @param {string} today
 */
export function reviewPriority(row, today) {
  const overdue = row.due_at ? Math.max(0, diffDays(row.due_at, today)) : 0;
  const acc = row.total_answers > 0 ? row.total_correct / row.total_answers : 1;

  return (
    overdue * 12 +                              // 逾期最要紧
    (row.total_wrong || 0) * 3 +                // 历史错误多
    (row.streak_wrong || 0) * 6 +               // 最近连续错
    (1 - acc) * 20 +                            // 正确率低
    (2.6 - (row.ease || EASE_INIT)) * 8 +       // 难度高
    (row.state === STATE.FRAGILE ? 15 : 0)      // 已标记易忘
  );
}

/** 这个单词是否已经算"学过" */
export function isStudied(state) {
  return !!state && (state.total_answers > 0 || state.state !== STATE.NEW);
}
