/**
 * text.js —— 文本规范化与解析工具
 *
 * 所有关于"什么是单词""怎么切中文义项"的判断集中在这里，
 * 保证导入、去重、核对、出题用的是同一套规则。
 */

/* 中文字符 */
const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;

/* 词性标记 -> 统一代码 */
export const POS_MAP = [
  { re: /\b(vt|vi|v)\.?\b|动词/i, code: 'v' },
  { re: /\bn\.?\b|名词/i, code: 'n' },
  { re: /\b(adj|a)\.?\b|形容词/i, code: 'adj' },
  { re: /\badv\.?\b|副词/i, code: 'adv' },
  { re: /\bprep\.?\b|介词/i, code: 'prep' },
  { re: /\bconj\.?\b|连词/i, code: 'conj' },
  { re: /\bpron\.?\b|代词/i, code: 'pron' },
  { re: /\bnum\.?\b|数词/i, code: 'num' },
  { re: /\bart\.?\b|冠词/i, code: 'art' },
  { re: /\bint\.?\b|interj\.?\b|感叹词/i, code: 'int' },
];

export const POS_LABEL = {
  n: 'n. 名词', v: 'v. 动词', adj: 'adj. 形容词', adv: 'adv. 副词',
  prep: 'prep. 介词', conj: 'conj. 连词', pron: 'pron. 代词',
  num: 'num. 数词', art: 'art. 冠词', int: 'int. 感叹词',
};

export function posLabel(codes) {
  if (!codes || !codes.length) return '—';
  return codes.map((c) => POS_LABEL[c] || c).join(' / ');
}

/** 提取文本里的词性代码 */
export function extractPos(text) {
  if (!text) return [];
  const found = [];
  for (const { re, code } of POS_MAP) {
    if (re.test(text) && !found.includes(code)) found.push(code);
  }
  return found;
}

/** 去掉释义开头的词性标记，如 "n. 苹果" -> "苹果" */
export function stripPosPrefix(s) {
  return String(s || '')
    .replace(/^\s*(\(?)(vt|vi|v|n|adj|adv|prep|conj|pron|num|art|int|a)\.?\s*/i, '')
    .trim();
}

/**
 * 单词规范化 —— 去重与比较的唯一依据
 * 忽略大小写、首尾空白、多余内部空白、首尾标点
 */
export function normalizeWord(w) {
  return String(w == null ? '' : w)
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'“”‘’()[\]{}.,;:!?·。，、；：！？]+|[\s"'“”‘’()[\]{}.,;:!?·。，、；：！？]+$/g, '');
}

/** 看起来像一个英文单词（允许连字符、撇号、空格组成的词组） */
export function isEnglishWord(s) {
  const t = String(s || '').trim();
  if (!t || t.length > 48) return false;
  if (CJK.test(t)) return false;
  return /^[A-Za-z][A-Za-z'’\- ]*$/.test(t);
}

export function hasChinese(s) {
  return CJK.test(String(s || ''));
}

/** 中文义项切分：按常见分隔符切成原子义项 */
export function splitSenses(s) {
  return String(s || '')
    .replace(/\r/g, '')
    .replace(/[\n]/g, '；')
    .split(/[;；,，、/|]+/)
    .map((x) => x.trim())
    .map(stripPosPrefix)
    .map((x) => x.replace(/^\[[^\]]{0,8}\]/, '').trim())   // 去掉 [医] [网络] 这类标注
    .filter((x) => x.length > 0 && x.length <= 40);
}

/* 无实际区分度的常用字，参与相似度计算时会虚高 */
const STOP_CHARS = new Set('的地得了着过是在和与或及之其而也都很更最不没无有为'.split(''));

/* ---------------------------------------------------------------
 * 中文近义词表（由 ECDICT 自身共现推导，见 tools/build_syn.py）
 * 纯字符重叠解决不了「实现 vs 完成」这类同义改写，必须靠这张表
 * ------------------------------------------------------------- */
let _syn = null;

export function setSynonymMap(map) {
  _syn = map || null;
}
export function hasSynonymMap() {
  return !!_syn;
}

function areSynonyms(a, b) {
  if (!_syn) return false;
  const list = _syn[a];
  return Array.isArray(list) && list.indexOf(b) >= 0;
}

function meaningfulChars(s) {
  const out = new Set();
  for (const ch of String(s || '')) {
    if (CJK.test(ch) && !STOP_CHARS.has(ch)) out.add(ch);
  }
  return out;
}

/**
 * 中文义项相似度 0~1
 * 顺序：完全相同 > 互相包含 > 近义词表 > 有效字符重叠
 */
export function cnSimilarity(a, b) {
  const x = String(a || '').trim();
  const y = String(b || '').trim();
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.95;
  if (areSynonyms(x, y) || areSynonyms(y, x)) return 0.9;

  const A = meaningfulChars(x);
  const B = meaningfulChars(y);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const c of A) if (B.has(c)) inter++;
  const denom = Math.min(A.size, B.size);
  return inter / denom;
}

/**
 * 多义项集合匹配：返回 {matched, matchRatio, coverageRatio, pairs}
 * @param {string[]} userSenses   用户原始义项
 * @param {string[]} refSenses    参考词典义项
 */
export function matchSenseSets(userSenses, refSenses, threshold = 0.6) {
  const pairs = [];
  const usedRef = new Set();
  let matched = 0;

  for (const u of userSenses) {
    let best = 0;
    let bestRef = -1;
    refSenses.forEach((r, i) => {
      const s = cnSimilarity(u, r);
      if (s > best) { best = s; bestRef = i; }
    });
    if (best >= threshold) {
      matched++;
      if (bestRef >= 0) usedRef.add(bestRef);
      pairs.push({ user: u, ref: refSenses[bestRef], score: best });
    } else {
      pairs.push({ user: u, ref: bestRef >= 0 ? refSenses[bestRef] : '', score: best });
    }
  }

  const matchRatio = userSenses.length ? matched / userSenses.length : 0;
  const coverageRatio = refSenses.length ? usedRef.size / refSenses.length : 0;
  return { matched, matchRatio, coverageRatio, pairs };
}

/** 英式/美式音标清洗：统一成 /.../ 形式 */
export function cleanIpa(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  const core = t.replace(/^[\/\[\s]+|[\/\]\s]+$/g, '');
  if (!core) return '';
  return '/' + core + '/';
}

/** 从一行文本里抓出用 /.../ 或 [...] 包裹的音标 */
export function extractIpa(s) {
  const m = String(s || '').match(/[\/\[]([^\/\]]{2,40})[\/\]]/);
  return m ? '/' + m[1].trim() + '/' : '';
}

/** 清理中文释义：去多余空白，保留原意 */
export function cleanTranslation(s) {
  return String(s || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '；')
    .replace(/；{2,}/g, '；')
    .replace(/^[；;,\s]+|[；;,\s]+$/g, '')
    .trim();
}

export function isCjkChar(ch) {
  return CJK.test(ch);
}
