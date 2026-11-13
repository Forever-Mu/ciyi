/**
 * quiz.js —— 题目生成与判分
 *
 * 四种题型：
 *   en2cn  看英文选中文
 *   cn2en  看中文选英文
 *   spell  看中文拼写英文
 *   en2def 看英文选释义（无英文例句/释义时退回 en2cn）
 *
 * 纯函数 + 可注入随机源，保证测试可复现。
 */

import { normalizeWord, splitSenses } from './text.js';

export const QTYPE = {
  en2cn: '看英文选中文',
  cn2en: '看中文选英文',
  spell: '看中文拼英文',
  en2def: '看英文选释义',
};

/** 默认题型配比：拼写占比略低，选择题为主 */
export const DEFAULT_TYPES = ['en2cn', 'cn2en', 'spell', 'en2def'];

/**
 * 按「拼写模式」开关过滤可用题型
 * @param {boolean} spellingEnabled 关闭时彻底不出拼写题
 * @param {string[]|string} all     可用题型（数组或逗号分隔）
 */
export function activeTypes(spellingEnabled, all) {
  let list;
  if (Array.isArray(all)) list = all.slice();
  else if (typeof all === 'string' && all.trim()) list = all.split(',').map((s) => s.trim());
  else list = DEFAULT_TYPES.slice();

  list = list.filter((t) => QTYPE[t]);
  if (!list.length) list = DEFAULT_TYPES.slice();

  if (spellingEnabled === false) list = list.filter((t) => t !== 'spell');
  if (!list.length) list = ['en2cn'];      // 兜底，绝不能空
  return list;
}

/** 可复现随机数（mulberry32） */
export function makeRng(seed = Date.now()) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(arr, rng) {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 单词可用于展示的中文释义 */
export function translationOf(word) {
  return word.confirmed_translation || word.original_translation || word.suggested_translation || '';
}

/** 取义项里最短的一个作为选项标签，避免选项过长 */
function shortestSense(translation) {
  const senses = splitSenses(translation);
  if (!senses.length) return String(translation || '').slice(0, 24);
  return senses.slice().sort((a, b) => a.length - b.length)[0];
}

/**
 * 选项标签：只取前几个义项并限长。
 * 一个词在词典里可能有七八个义项，全塞进选项会把界面撑爆，
 * 也让用户没法快速扫读。完整释义在答完的反馈里给。
 */
function optionLabel(translation, maxSenses = 2, maxLen = 22) {
  const senses = splitSenses(translation);
  let s = senses.slice(0, maxSenses).join('；') || String(translation || '').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen) + '…';
  return s;
}

/**
 * 生成一道题
 *
 * @param {object} word   当前单词行（需含 word/display_word/释义/pos/音标/例句）
 * @param {object[]} pool 其他单词，用于生成干扰项
 * @param {object} opts   { types, rng, optionCount }
 * @returns {object|null} 无法出题（没有释义/干扰项不足）时返回 null，调用方应跳过该词
 */
export function buildQuestion(word, pool, opts = {}) {
  const rng = opts.rng || makeRng();
  const types = (opts.types && opts.types.length ? opts.types : DEFAULT_TYPES).filter((t) => QTYPE[t]);
  const optionCount = opts.optionCount || 4;

  const display = String((word && (word.display_word || word.word)) || '').trim();
  const trans = translationOf(word);
  const senses = splitSenses(trans);
  const mainSense = shortestSense(trans);

  // 没有英文或没有中文释义的词，出不出题 —— 宁可跳过，也不能给用户一道空题
  if (!display) return null;
  if (!senses.length && !String(trans || '').trim()) return null;

  // en2def 需要英文材料，没有就退回 en2cn
  let type = pick(types, rng);
  if (type === 'en2def' && !word.english_example && !word.definition_en) type = 'en2cn';

  // 干扰项池：排除自己，优先同词性
  const myPos = String(word.part_of_speech || '').split(',').map((s) => s.trim()).filter(Boolean);
  const others = (pool || []).filter(
    (p) => p && normalizeWord(p.word) !== normalizeWord(word.word)
  );
  const samePos = others.filter((p) => {
    const pp = String(p.part_of_speech || '').split(',').map((s) => s.trim()).filter(Boolean);
    return pp.some((x) => myPos.includes(x));
  });

  function distractors(pickTranslation) {
    const src = samePos.length >= optionCount - 1 ? samePos : others;
    const shuffled = shuffle(src, rng);
    const out = [];
    const seen = new Set([pickTranslation(word)]);
    for (const cand of shuffled) {
      const label = String(pickTranslation(cand) || '').trim();
      if (!label) continue;
      if (seen.has(label)) continue;
      seen.add(label);
      out.push(label);
      if (out.length >= optionCount - 1) break;
    }
    return out;
  }

  if (type === 'spell') {
    return {
      type,
      word,
      prompt: mainSense || '（无释义）',
      promptSub: word.part_of_speech ? word.part_of_speech.replace(/,/g, ' / ') : '',
      promptKind: 'cn',
      options: [],
      answerIndex: -1,
      answer: display,
      hint: `首字母 ${display[0] || '?'} · 共 ${display.replace(/[^A-Za-z]/g, '').length} 个字母`,
    };
  }

  if (type === 'cn2en') {
    const answer = display;
    const wrong = distractors((w) => w.display_word || w.word);
    if (wrong.length < 1) return null;          // 干扰项不足，出选择题没有意义
    const options = shuffle([answer, ...wrong], rng);
    return {
      type,
      word,
      prompt: mainSense || '（无释义）',
      promptSub: senses.length > 1 ? senses.slice(0, 3).join('；') : '',
      promptKind: 'cn',
      options,
      answerIndex: options.indexOf(answer),
      answer,
    };
  }

  // en2cn / en2def
  const answer = type === 'en2def'
    ? (word.english_example ? `例：${word.english_example}` : mainSense)
    : optionLabel(trans, 3, 26);
  if (!String(answer || '').trim()) return null;

  const wrong = distractors((w) => optionLabel(translationOf(w), 2, 22));
  if (wrong.length < 1) return null;

  const options = shuffle([answer, ...wrong], rng);
  return {
    type,
    word,
    prompt: display,
    promptSub: word.uk_ipa || '',
    promptKind: 'en',
    options,
    answerIndex: options.indexOf(answer),
    answer,
  };
}

/** 判分：返回 {correct, normalized} */
export function gradeAnswer(question, response) {
  if (question.type === 'spell') {
    return gradeSpelling(response, question.answer, question.word);
  }
  const idx = typeof response === 'number' ? response : parseInt(response, 10);
  return {
    correct: idx === question.answerIndex,
    normalized: String(question.options[idx] != null ? question.options[idx] : ''),
  };
}

/**
 * 拼写判分
 * 规则：
 *   · 忽略大小写、首尾空白、内部连续空白
 *   · 允许预先配置的其它正确形式（word.variants）
 *   · 明显错误（差一个字母以上）不放过
 */
export function gradeSpelling(input, answer, word) {
  const norm = (s) => normalizeWord(s).replace(/\s+/g, ' ');
  const a = norm(answer);
  const u = norm(input);
  if (!u) return { correct: false, normalized: u };

  const accepted = new Set([a]);
  const variants = (word && (word.variants || word.accepted_answers)) || [];
  if (Array.isArray(variants)) variants.forEach((v) => accepted.add(norm(v)));

  if (accepted.has(u)) return { correct: true, normalized: u };

  // 允许单复数/连字符差异这类等价写法（仅限预先声明的变体）
  return { correct: false, normalized: u };
}

/** 计算字符串编辑距离（给"接近但错"的提示用） */
export function levenshtein(a, b) {
  const s = String(a || ''), t = String(b || '');
  const m = s.length, n = t.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}
