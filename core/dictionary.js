/**
 * dictionary.js —— 词典服务
 *
 * 两个数据来源，分工明确：
 *   1. LocalDictionary  离线英汉词典（ECDICT 子集，58226 词条）
 *        -> 中文释义、音标、词性。翻译核对的主依据，完全离线。
 *   2. RemoteDictionary 在线词典 dictionaryapi.dev（免费、无需密钥）
 *        -> 英文释义、更多音标、例句。用于补充资料，失败不影响导入。
 *
 * 封装成统一接口，以后换词典实现只要实现 lookup 即可。
 */

import { readBinary, getFflate, fetchJson, hasNetwork } from './platform.js';
import { extractPos, cleanIpa, setSynonymMap } from './text.js';

/**
 * 加载中文近义词表（由 ECDICT 共现推导）
 * 不加载也能跑，只是同义改写会更容易被判成"可能错误"
 */
export async function loadSynonymMap(src) {
  const [fflate, bytes] = await Promise.all([getFflate(), readBinary(src)]);
  const map = JSON.parse(fflate.strFromU8(fflate.gunzipSync(bytes)));
  setSynonymMap(map);
  return map;
}

/* ================================================================
 *  离线词典
 * ================================================================ */

export class LocalDictionary {
  constructor(map) {
    this.map = map;             // { word: [phonetic, translation, pos[]?] }
    this.size = Object.keys(map).length;
  }

  /**
   * 加载 data/dict.json.gz
   * @param {string} src Node=路径 浏览器=URL
   */
  static async load(src) {
    const [fflate, bytes] = await Promise.all([getFflate(), readBinary(src)]);
    const raw = fflate.strFromU8(fflate.gunzipSync(bytes));
    const map = JSON.parse(raw);
    return new LocalDictionary(map);
  }

  /** @returns {{phonetic:string, translation:string, pos:string[]}|null} */
  lookup(word) {
    const k = String(word || '').toLowerCase().trim();
    if (!k) return null;
    const rec = this.map[k];
    if (!rec) return null;
    return {
      phonetic: rec[0] || '',
      translation: rec[1] || '',
      pos: Array.isArray(rec[2]) ? rec[2] : extractPos(rec[1] || ''),
      source: 'ECDICT',
    };
  }
}

/* ================================================================
 *  在线词典
 * ================================================================ */

const API_BASE = 'https://api.dictionaryapi.dev/api/v2/entries/en/';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class RemoteDictionary {
  /**
   * @param {object} opts
   * @param {number} [opts.timeoutMs]   单次请求超时
   * @param {number} [opts.minInterval] 两次请求的最小间隔（毫秒）
   * @param {number} [opts.maxRetries]  429/5xx/超时的重试次数
   */
  constructor(opts = {}) {
    this.timeoutMs = opts.timeoutMs || 12000;
    this.minInterval = opts.minInterval == null ? 260 : opts.minInterval;
    this.maxRetries = opts.maxRetries == null ? 3 : opts.maxRetries;
    this.cache = new Map();       // 进程内缓存，避免同一个词反复请求
    this.enabled = opts.enabled !== false;
    this._lastAt = 0;             // 上次请求时间，用于节流
    this.rateLimited = false;     // 是否曾触发限流（供 UI 提示）
  }

  /** 节流：保证两次请求之间有最小间隔 */
  async _throttle() {
    if (this.minInterval <= 0) return;
    const wait = this._lastAt + this.minInterval - Date.now();
    if (wait > 0) await sleep(wait);
    this._lastAt = Date.now();
  }

  /**
   * @returns {Promise<{ok:boolean, notFound?:boolean, data?:object, error?:string, rateLimited?:boolean}>}
   */
  async lookup(word) {
    const k = String(word || '').trim().toLowerCase();
    if (!k) return { ok: false, error: '空单词' };
    if (!this.enabled) return { ok: false, error: '在线词典已关闭' };
    if (!hasNetwork()) return { ok: false, error: '当前处于离线状态' };
    if (this.cache.has(k)) return this.cache.get(k);

    const url = API_BASE + encodeURIComponent(k);
    let lastErr = '';

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this._throttle();
      const res = await fetchJson(url, { timeoutMs: this.timeoutMs });

      if (res.ok) {
        const parsed = normalizeRemote(k, res.data);
        this.cache.set(k, parsed);
        return parsed;
      }

      // 确认没有这个词 —— 缓存，以后不再请求
      if (res.notFound) {
        const out = { ok: false, notFound: true, error: '在线词典无此词条' };
        this.cache.set(k, out);
        return out;
      }

      // 限流 / 服务端错误 / 超时：退避后重试
      const retriable = res.status === 429 || (res.status && res.status >= 500) || res.timeout;
      lastErr = res.error || '查询失败';
      if (res.status === 429) this.rateLimited = true;

      if (!retriable || attempt === this.maxRetries) break;

      // 优先听服务端的 Retry-After，否则指数退避
      const wait = res.retryAfter ? res.retryAfter * 1000 : Math.min(4000, 500 * Math.pow(2, attempt));
      await sleep(wait);
    }

    // 网络类错误不缓存，网络恢复后还能重试
    return {
      ok: false,
      error: /429/.test(lastErr) ? '在线词典请求过于频繁，已跳过' : lastErr,
      rateLimited: this.rateLimited,
    };
  }
}

/** dictionaryapi.dev 用全称词性（verb / adjective），本应用统一用短码（v / adj） */
const REMOTE_POS_MAP = {
  noun: 'n', n: 'n',
  verb: 'v', v: 'v',
  adjective: 'adj', adj: 'adj', a: 'adj', determiner: 'adj',
  adverb: 'adv', adv: 'adv',
  preposition: 'prep', prep: 'prep',
  conjunction: 'conj', conj: 'conj',
  pronoun: 'pron', pron: 'pron',
  numeral: 'num', num: 'num', number: 'num',
  article: 'art', art: 'art',
  interjection: 'int', exclamation: 'int', int: 'int',
};

function normalizeRemotePos(p) {
  return REMOTE_POS_MAP[String(p || '').toLowerCase().trim()] || '';
}

/** 把 dictionaryapi.dev 的返回整理成统一结构 */
function normalizeRemote(word, data) {
  const entry = Array.isArray(data) ? data[0] : data;
  if (!entry) return { ok: false, error: '返回内容为空' };

  const phonetics = Array.isArray(entry.phonetics) ? entry.phonetics : [];
  let uk = '', us = '';
  const texts = [];

  for (const p of phonetics) {
    const t = cleanIpa(p.text || '');
    const audio = String(p.audio || '');
    if (!t) continue;
    if (!uk && (/-uk\./i.test(audio) || /uk/i.test(p.sourceUrl || ''))) { uk = t; continue; }
    if (!us && (/-us\./i.test(audio) || /us/i.test(p.sourceUrl || ''))) { us = t; continue; }
    if (!texts.includes(t)) texts.push(t);
  }
  if (!uk && texts.length) uk = texts[0];
  if (!us && texts.length > 1) us = texts[1];
  const mainPhonetic = cleanIpa(entry.phonetic || '') || uk || (texts[0] || '');

  const meanings = Array.isArray(entry.meanings) ? entry.meanings : [];
  const pos = [];
  const defs = [];
  const examples = [];

  for (const m of meanings) {
    const raw = String(m.partOfSpeech || '').toLowerCase();
    const p = normalizeRemotePos(raw);
    if (p && !pos.includes(p)) pos.push(p);
    for (const d of (m.definitions || [])) {
      const text = String(d.definition || '').trim();
      if (text) defs.push({ pos: p || raw, text });
      const ex = String(d.example || '').trim();
      if (ex && examples.length < 3) examples.push(ex);
    }
  }

  return {
    ok: true,
    word: String(entry.word || word),
    phonetic: mainPhonetic,
    ukIpa: uk,
    usIpa: us,
    pos,
    definitions: defs,
    examples,
    source: 'dictionaryapi.dev',
  };
}

/* ================================================================
 *  组合服务
 * ================================================================ */

export class DictionaryService {
  /**
   * @param {{local?:LocalDictionary, remote?:RemoteDictionary}} deps
   */
  constructor(deps = {}) {
    this.local = deps.local || null;
    this.remote = deps.remote || null;
  }

  /**
   * 取「翻译核对」用的参考数据（优先离线，保证断网可用）
   * @returns {{cnSenses:string[], pos:string[], ukIpa:string, usIpa:string, sources:string[], hasRef:boolean}}
   */
  reference(word) {
    const loc = this.local ? this.local.lookup(word) : null;
    const cnSenses = loc ? splitRefSenses(loc.translation) : [];
    return {
      word,
      cnSenses,
      pos: loc ? loc.pos : [],
      ukIpa: loc ? cleanIpa(loc.phonetic) : '',
      usIpa: '',
      raw: loc ? loc.translation : '',
      sources: loc ? ['ECDICT'] : [],
      hasRef: cnSenses.length > 0,
    };
  }

  /**
   * 补充资料（音标/词性/例句）。原词表已有的字段不会被覆盖。
   * @param {object} row 导入的原始记录
   * @param {{allowOnline?:boolean}} opts
   * @returns {Promise<object>} 合并后的字段 + 来源说明
   */
  async enrich(row, opts = {}) {
    const allowOnline = opts.allowOnline !== false && !!this.remote;
    const loc = this.local ? this.local.lookup(row.word) : null;

    const out = {
      ukIpa: row.ukIpa || '',
      usIpa: row.usIpa || '',
      pos: Array.isArray(row.pos) ? row.pos.slice() : [],
      englishExample: row.example || '',
      exampleTranslation: row.exampleTranslation || '',
      online: null,
      sources: [],
      onlineError: '',
    };

    // 离线词典补音标 / 词性
    if (loc) {
      out.sources.push('ECDICT');
      if (!out.ukIpa && loc.phonetic) out.ukIpa = cleanIpa(loc.phonetic);
      if (!out.pos.length && loc.pos.length) out.pos = loc.pos.slice();
    }

    // 在线补英文释义 / 例句 / 更准确的英美音标
    if (allowOnline) {
      const r = await this.remote.lookup(row.word);
      if (r.ok) {
        out.online = r;
        out.sources.push('dictionaryapi.dev');
        if (r.ukIpa && !out.ukIpa) out.ukIpa = r.ukIpa;
        if (r.usIpa && !out.usIpa) out.usIpa = r.usIpa;
        if (r.ukIpa && !row.ukIpa) out.ukIpa = r.ukIpa;
        if (r.usIpa && !row.usIpa) out.usIpa = r.usIpa;
        if (!out.pos.length && r.pos.length) out.pos = r.pos.slice();
        if (!out.englishExample && r.examples.length) out.englishExample = r.examples[0];
      } else {
        // notFound 要排在通用 error 前面，否则 404 会显示成含糊的"查询失败"
        out.onlineError = r.notFound ? '在线词典无此词条' : (r.error || '在线查询失败');
      }
    } else if (!this.remote) {
      out.onlineError = '未配置在线词典';
    }

    return out;
  }
}

/** 把词典的中文释义拆成义项原子，去掉 [网络] 这类次要标注 */
export function splitRefSenses(translation) {
  return String(translation || '')
    .replace(/\r/g, '')
    .split(/[;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^\[[^\]]{0,8}\]/, '').trim())
    .filter((s) => s && !/^\[/.test(s))
    .flatMap((s) => s.split(/[,，、]/))
    .map((s) => s.trim())
    .map((s) => s.replace(/^(vt|vi|v|n|adj|adv|prep|conj|pron|num|art|int|a)\.?\s*/i, ''))
    .filter((s) => s.length > 0 && s.length <= 30);
}
