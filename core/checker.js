/**
 * checker.js —— 翻译准确性核对
 *
 * 目标：判断「Word 里写的英文 -> 中文释义」是否对得上。
 *
 * 三个刻意为之的设计：
 *
 * 1) 判据是「义项匹配」，不是「字面相等」。
 *    abandon 放弃;抛弃   vs 词典 放弃;遗弃;抛弃  -> 正确
 *    accurate 准确的      vs 词典 正确的;精确的    -> 正确（准确的/正确的 共享核心语素“确”）
 *
 * 2) 覆盖不全不算错。
 *    charge 写“充电”，词典有十几条义项 —— 这是「其中一个正确词义」，
 *    最多降级为「基本正确但不完整」，绝不能判错。
 *
 * 3) 宁可保守，不可武断。
 *    拿不准就返回 E(无法确认)，而不是硬给一个结论。
 */

import { splitSenses, cnSimilarity, extractPos } from './text.js';
import { splitRefSenses } from './dictionary.js';

/** 判定为"同一个义项"的相似度阈值。偏低是有意的：中文同义改写极多。 */
export const MATCH_THRESHOLD = 0.5;
/** 弱匹配：不足以判对，但也不该被判成"完全错误" */
export const WEAK_THRESHOLD = 0.34;

export const STATUS = {
  A: { code: 'A', label: '翻译正确', tone: 'ok' },
  B: { code: 'B', label: '基本正确，但不完整', tone: 'warn' },
  C: { code: 'C', label: '可能存在错误', tone: 'warn' },
  D: { code: 'D', label: '确认错误', tone: 'bad' },
  E: { code: 'E', label: '无法确认', tone: 'mute' },
  PENDING: { code: 'pending', label: '待核对', tone: 'mute' },
};

/**
 * 核对一个单词的翻译
 *
 * @param {object} input
 * @param {string} input.word               英文
 * @param {string} input.originalTranslation Word 原始中文释义
 * @param {string[]} [input.declaredPos]    Word 声明的词性
 * @param {object} input.reference          DictionaryService.reference() 的返回
 * @returns {{status, confidence, reason, suggested, details, sources}}
 */
export function checkTranslation(input) {
  const word = String(input.word || '').trim();
  const original = String(input.originalTranslation || '').trim();
  const declaredPos = input.declaredPos || [];
  const ref = input.reference || {};

  const empty = {
    status: 'E', confidence: 0, suggested: '', details: null,
    sources: (ref.sources || []).slice(),
  };

  // ---- 没有原始译文 ----
  if (!original) {
    return { ...empty, status: 'E', confidence: 0.9, reason: '词表里没有提供中文释义，无法核对' };
  }

  // ---- 没有词典参考 ----
  if (!ref.hasRef) {
    return {
      ...empty,
      status: 'E',
      confidence: 0.5,
      reason: '离线词典中没有收录该词条，且当前无法从在线词典取得参考释义',
    };
  }

  const userSenses = splitSenses(original);
  const refSenses = splitRefSenses(ref.raw || '');
  const refPos = (ref.pos || []).length ? ref.pos : extractPos(ref.raw || '');

  if (!userSenses.length) {
    return { ...empty, status: 'E', confidence: 0.6, reason: '原始释义里没有可识别的中文义项' };
  }
  if (!refSenses.length) {
    return { ...empty, status: 'E', confidence: 0.5, reason: '词典释义为空，无法比较' };
  }

  // ---- 逐义项匹配 ----
  const pairs = [];
  const hitRef = new Set();
  let matched = 0;
  let bestScore = 0;

  for (const u of userSenses) {
    let best = 0;
    let bestRef = -1;
    refSenses.forEach((r, i) => {
      const s = cnSimilarity(u, r);
      if (s > best) { best = s; bestRef = i; }
    });
    bestScore = Math.max(bestScore, best);
    const isMatch = best >= MATCH_THRESHOLD;
    if (isMatch) {
      matched++;
      if (bestRef >= 0) hitRef.add(bestRef);
    }
    pairs.push({
      user: u,
      ref: bestRef >= 0 ? refSenses[bestRef] : '',
      score: Math.round(best * 100) / 100,
      matched: isMatch,
    });
  }

  const matchRatio = matched / userSenses.length;

  // 覆盖了词典的前几条主要义项吗（用来判断"是否够完整"）
  const topN = Math.min(2, refSenses.length);
  let coveredTop = 0;
  for (let i = 0; i < topN; i++) if (hitRef.has(i)) coveredTop++;

  // ---- 词性一致性 ----
  let posOk = null;
  if (declaredPos.length && refPos.length) {
    posOk = declaredPos.some((p) => refPos.includes(p));
  }

  // ---- 定级 ----
  let status;
  let confidence;
  let reason;

  if (matchRatio >= 0.999) {
    if (refSenses.length >= 3 && coveredTop === 0) {
      status = 'B';
      confidence = 0.72;
      const missing = refSenses.filter((_, i) => !hitRef.has(i)).slice(0, 3);
      reason = `原始释义与词典中某一义项一致，但未覆盖该词的主要义项（如 ${missing.join('、')}）`;
    } else {
      status = 'A';
      confidence = refSenses.length >= 2 ? 0.92 : 0.82;
      reason = `原始释义与词典释义一致（匹配 ${matched}/${userSenses.length} 个义项）`;
    }
  } else if (matchRatio >= 0.5) {
    status = 'C';
    confidence = 0.55;
    const bad = pairs.filter((p) => !p.matched).map((p) => p.user);
    reason = `部分义项在词典中找不到对应：${bad.join('、')}`;
  } else if (bestScore >= WEAK_THRESHOLD) {
    status = 'C';
    confidence = 0.45;
    reason = '原始释义与词典释义只有部分字面接近，含义是否一致需要人工确认';
  } else {
    status = 'D';
    // 词典义项越丰富，判"确认错误"越有底气
    confidence = refSenses.length >= 2 ? 0.8 : 0.62;
    reason = `原始释义与词典释义没有对应关系（词典为：${refSenses.slice(0, 4).join('、')}）`;
  }

  // ---- 词性不一致时降置信度并记录，但不单独改判 ----
  if (posOk === false) {
    confidence = Math.max(0.3, confidence - 0.12);
    reason += `；另外词性可能不符（原始 ${declaredPos.join('/') || '未标注'}，词典 ${refPos.join('/')}）`;
  }

  // ---- 建议释义 ----
  let suggested = '';
  if (status === 'B') {
    // 保留原文，追加缺失的主要义项
    const missing = refSenses.filter((_, i) => !hitRef.has(i)).slice(0, 2);
    suggested = missing.length ? `${original}；${missing.join('；')}` : '';
  } else if (status === 'C' || status === 'D') {
    suggested = refSenses.slice(0, 4).join('；');
  } else if (status === 'A') {
    suggested = '';
  }

  return {
    status,
    confidence: Math.round(confidence * 100) / 100,
    reason,
    suggested,
    details: {
      userSenses,
      refSenses: refSenses.slice(0, 12),
      pairs,
      matchRatio: Math.round(matchRatio * 100) / 100,
      coveredTop,
      posOk,
      declaredPos,
      refPos,
    },
    sources: (ref.sources || []).slice(),
  };
}

/**
 * 批量核对
 * @param {Array} items  [{word, originalTranslation, declaredPos, reference}]
 * @returns {{results:Array, report:object}}
 */
export function checkBatch(items) {
  const results = items.map((it) => ({
    word: it.word,
    ...checkTranslation(it),
  }));

  const report = {
    total: results.length,
    A: 0, B: 0, C: 0, D: 0, E: 0,
    needsReview: 0,      // B/C/D 需要人工看一眼
    autoOk: 0,           // A 可以直接用
  };
  for (const r of results) {
    if (report[r.status] !== undefined) report[r.status]++;
    if (r.status === 'A') report.autoOk++;
    else report.needsReview++;
  }
  return { results, report };
}
