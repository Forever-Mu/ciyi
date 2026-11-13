/**
 * parse.js —— 单词表导入解析
 *
 * 支持两条来源：
 *   1. 粘贴的纯文本（空格/Tab/逗号/冒号分隔，一行一词）
 *   2. .docx 文档（表格 + 段落）
 *
 * 设计原则：不假设格式统一。
 *   · docx 表格 -> 逐列做「角色识别」，由内容统计决定哪列是英文/中文/词性/音标
 *   · 纯文本   -> 逐行找「英文 / 中文」的边界，不靠固定分隔符
 */

import {
  normalizeWord, isEnglishWord, hasChinese, extractPos, extractIpa,
  cleanIpa, cleanTranslation, stripPosPrefix, splitSenses, cnSimilarity,
} from './text.js';

/* ================================================================
 *  XML / docx
 * ================================================================ */

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(s) {
  return String(s || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X'
        ? parseInt(g.slice(2), 16)
        : parseInt(g.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code < 0x110000) {
        try { return String.fromCodePoint(code); } catch (e) { return m; }
      }
      return m;
    }
    return XML_ENTITIES[g] !== undefined ? XML_ENTITIES[g] : m;
  });
}

/**
 * 匹配 docx 里我们关心的两种 token：
 *   1) <w:t>文本</w:t>  —— 文本节点
 *   2) 结构标签          —— tbl / tr / tc / p / tab / br
 *
 * 注意：不能用 tok.startsWith('<w:t') 判断文本，
 * 因为 '<w:tbl>' 也满足这个前缀，会把表格标签误判成文本标签吞掉。
 * 这里改用「是否有文本捕获组」来区分。
 */
const TOKEN_RE = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<(\/?)(w:tbl|w:tr|w:tc|w:p|w:tab|w:br)\b[^>]*?(\/?)>/g;

/**
 * 从 document.xml 文本里抽取表格与段落
 * @returns {{tables: string[][][], paragraphs: string[]}}
 */
export function extractDocxContent(xml) {
  const tables = [];
  const paragraphs = [];

  let tblDepth = 0;
  let curTable = null;
  let curRow = null;
  let cellText = null;     // 非 null 表示正在某个单元格里
  let paraText = '';

  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(xml)) !== null) {
    // ---- 文本节点 ----
    if (m[1] !== undefined) {
      const text = decodeXml(m[1]);
      if (cellText !== null) cellText += text;
      else paraText += text;
      continue;
    }

    // ---- 结构标签 ----
    const closing = m[2] === '/';
    const name = m[3];
    const selfClosing = m[4] === '/';

    if (name === 'w:tab') {
      if (cellText !== null) cellText += ' ';
      else paraText += '\t';
    } else if (name === 'w:br') {
      if (cellText !== null) cellText += ' ';
      else paraText += '\n';
    } else if (name === 'w:tbl') {
      if (closing) {
        tblDepth = Math.max(0, tblDepth - 1);
        if (curTable) tables.push(curTable);
        curTable = null;
      } else if (!selfClosing) {
        tblDepth++;
        curTable = [];
      }
    } else if (name === 'w:tr') {
      if (closing) {
        if (curRow && curTable) curTable.push(curRow);
        curRow = null;
      } else if (!selfClosing) {
        curRow = [];
      }
    } else if (name === 'w:tc') {
      if (closing) {
        if (curRow) curRow.push((cellText || '').replace(/\s+/g, ' ').trim());
        cellText = null;
      } else if (!selfClosing) {
        cellText = '';
      }
    } else if (name === 'w:p') {
      if (closing) {
        if (tblDepth === 0) {
          const t = paraText.replace(/\s+/g, ' ').trim();
          if (t) paragraphs.push(t);
        }
        paraText = '';
      } else if (!selfClosing) {
        paraText = '';
      }
    }
  }
  return { tables, paragraphs };
}

/** docx 是 zip，取出 word/document.xml */
export function extractDocumentXml(buf, unzipSync) {
  const files = unzipSync(new Uint8Array(buf));
  const key = Object.keys(files).find((k) => /^word\/document\d*\.xml$/i.test(k));
  if (!key) return null;
  const bytes = files[key];
  // 手动 UTF-8 解码（浏览器 / node 都可用）
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
  return Buffer.from(bytes).toString('utf8');
}

/* ================================================================
 *  单行解析（纯文本）
 * ================================================================ */

/** 从字符串里剥出：英文词、音标、词性 */
function splitEnglishPart(prefix) {
  let s = String(prefix || '');
  let uk = '', us = '';
  const ipaAll = [];

  // 抓所有 /.../ 或 [...] 音标
  const ipaRe = /[\/\[]([^\/\]\[]{2,48})[\/\]]/g;
  let m;
  while ((m = ipaRe.exec(s)) !== null) {
    const ipa = cleanIpa(m[1]);
    if (ipa && /[a-zA-Zɑɒæəɜɪʊʌθðʃʒŋˈˌː]/.test(m[1])) ipaAll.push(ipa);
  }
  s = s.replace(ipaRe, ' ');

  const pos = extractPos(s);
  // 去掉词性标记（连同其后的句点，否则 "vt." 会残留 ".")
  s = s.replace(/\b(vt|vi|v|n|adj|adv|prep|conj|pron|num|art|int|a)\.?(?=\s|$|[，。；,;:：、])/gi, ' ');

  // 清理残留标点后剩下的才是英文词
  const word = s.replace(/[\s,;:：，；、|.]+/g, ' ').trim();

  if (ipaAll.length === 1) uk = ipaAll[0];
  else if (ipaAll.length >= 2) { uk = ipaAll[0]; us = ipaAll[1]; }

  return { word, pos, uk, us };
}

/** 从中文串里切出「释义」和「例句」 */
function splitChinesePart(rest) {
  let s = String(rest || '').trim();
  let example = '', exampleCn = '';

  // 例句标记
  const exMarker = /(例句|例:|例：|e\.g\.|eg\.|for example)/i;
  const mm = s.match(exMarker);
  if (mm && mm.index > 0) {
    const tail = s.slice(mm.index);
    s = s.slice(0, mm.index).trim();
    const body = tail.replace(exMarker, '').replace(/^[:：\s]+/, '').trim();
    // 例句里可能同时有英文和中文，按第一个中文字符切开
    const firstCjk = body.search(/[\u4e00-\u9fff]/);
    if (firstCjk > 0) {
      example = body.slice(0, firstCjk).trim();
      exampleCn = body.slice(firstCjk).trim();
    } else {
      example = body;
    }
  }
  return { translation: cleanTranslation(s), example, exampleCn };
}

/**
 * 解析一行纯文本 -> 候选记录
 * 处理顺序：找第一个中文字符作为分界，左边是英文区，右边是中文区
 */
export function parseLine(line) {
  const raw = String(line || '').replace(/\u00a0/g, ' ').trim();
  if (!raw) return null;

  // 纯分隔符模式：形如 "apple\t苹果" 或 "apple,苹果" 或 "apple:苹果"
  const delimMatch = raw.match(/^([A-Za-z][A-Za-z'’\- ]*?)\s*[\t,;:：，；]\s*(.+)$/);
  const firstCjk = raw.search(/[\u4e00-\u9fff]/);

  let wordPart = '';
  let cnPart = '';

  if (delimMatch && (!raw.includes('\t') || firstCjk < 0)) {
    wordPart = delimMatch[1];
    cnPart = delimMatch[2];
  } else if (firstCjk > 0) {
    wordPart = raw.slice(0, firstCjk);
    cnPart = raw.slice(firstCjk);
  } else if (firstCjk === 0) {
    // 中文在前，例如 "苹果 apple" —— 尝试把行尾的英文片段摘出来
    const tail = raw.match(/([A-Za-z][A-Za-z'’\- ]*)$/);
    if (tail && isEnglishWord(tail[1].trim())) {
      wordPart = tail[1];
      cnPart = raw.slice(0, raw.length - tail[1].length);
    } else {
      return { raw, word: '', translation: cleanTranslation(raw), pos: [], ukIpa: '', usIpa: '',
        example: '', exampleTranslation: '', score: 0, issues: ['这一行没有英文单词'] };
    }
  } else {
    // 整行没有中文：可能是纯英文列表
    const en = splitEnglishPart(raw);
    return { raw, word: en.word, translation: '', pos: en.pos, ukIpa: en.uk, usIpa: en.us,
      example: '', exampleTranslation: '', score: en.word ? 0.55 : 0,
      issues: ['缺少中文释义'] };
  }

  const en = splitEnglishPart(wordPart);
  const cn = splitChinesePart(cnPart);

  const word = en.word.trim();
  const issues = [];
  let score = 1;

  if (!word) { issues.push('未识别出英文单词'); score = 0; }
  else if (!isEnglishWord(word)) { issues.push('英文部分包含异常字符'); score = Math.min(score, 0.4); }
  if (word.includes(' ')) { issues.push('识别到的是词组而非单词'); score = Math.min(score, 0.75); }
  if (!cn.translation) { issues.push('缺少中文释义'); score = Math.min(score, 0.5); }
  if (!hasChinese(cn.translation) && cn.translation) { issues.push('释义里没有中文'); score = Math.min(score, 0.6); }

  return {
    raw,
    word,
    translation: cn.translation,
    pos: en.pos,
    ukIpa: en.uk,
    usIpa: en.us,
    example: cn.example,
    exampleTranslation: cn.exampleCn,
    score,
    issues,
  };
}

/* ================================================================
 *  列角色识别（docx 表格）
 * ================================================================ */

function columnStats(rows, col) {
  let total = 0, english = 0, chinese = 0, pos = 0, ipa = 0, numeric = 0;
  let enWords = 0, cnLen = 0;
  for (const r of rows) {
    const v = (r[col] || '').trim();
    if (!v) continue;
    total++;
    const isEn = isEnglishWord(v);
    const isCn = hasChinese(v);
    if (isEn) { english++; enWords += v.split(/\s+/).length; }
    if (isCn) { chinese++; cnLen += v.length; }
    if (extractPos(v).length && v.length <= 12) pos++;
    if (/[\/\[]/.test(v) && /[ɑɒæəɜɪʊʌθðʃʒŋ]/.test(v)) ipa++;
    if (/^-?\d+(\.\d+)?$/.test(v)) numeric++;
  }
  return {
    total,
    englishRatio: total ? english / total : 0,
    chineseRatio: total ? chinese / total : 0,
    posRatio: total ? pos / total : 0,
    ipaRatio: total ? ipa / total : 0,
    avgEnWords: english ? enWords / english : 0,
    avgCnLen: chinese ? cnLen / chinese : 0,
  };
}

/**
 * 识别表格各列角色
 * @returns {{word:number, translation:number, pos:number, ipa:number[], example:number}}
 */
export function detectColumnRoles(rows) {
  const nCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const stats = [];
  for (let c = 0; c < nCols; c++) stats.push(columnStats(rows, c));

  const used = new Set();
  const roles = { word: -1, translation: -1, pos: -1, ipa: [], example: -1 };

  // 1) 英文列：englishRatio 高且平均词数少
  let best = -1, bestScore = 0;
  stats.forEach((s, c) => {
    const score = s.englishRatio * (s.avgEnWords >= 0.5 ? 1 : 0) * (s.avgEnWords <= 2 ? 1 : 0.4);
    if (score > bestScore) { bestScore = score; best = c; }
  });
  if (best >= 0 && bestScore >= 0.5) { roles.word = best; used.add(best); }

  // 2) 音标列
  stats.forEach((s, c) => {
    if (used.has(c)) return;
    if (s.ipaRatio >= 0.5) { roles.ipa.push(c); used.add(c); }
  });

  // 3) 词性列
  best = -1; bestScore = 0;
  stats.forEach((s, c) => {
    if (used.has(c)) return;
    if (s.posRatio > bestScore) { bestScore = s.posRatio; best = c; }
  });
  if (best >= 0 && bestScore >= 0.4) { roles.pos = best; used.add(best); }

  // 4) 中文释义列：chineseRatio 高且平均长度短
  best = -1; bestScore = 0;
  stats.forEach((s, c) => {
    if (used.has(c)) return;
    const score = s.chineseRatio * (s.avgCnLen <= 40 ? 1 : 0.6);
    if (score > bestScore) { bestScore = score; best = c; }
  });
  if (best >= 0 && bestScore >= 0.5) { roles.translation = best; used.add(best); }

  // 5) 例句列：英文列里平均词数最多的
  best = -1; bestScore = 0;
  stats.forEach((s, c) => {
    if (used.has(c)) return;
    if (s.englishRatio >= 0.4 && s.avgEnWords >= 3) {
      if (s.avgEnWords > bestScore) { bestScore = s.avgEnWords; best = c; }
    }
  });
  if (best >= 0) { roles.example = best; used.add(best); }

  return { roles, stats, nCols };
}

/** 常见表头词 */
const HEADER_WORDS = /^(单词|释义|词性|音标|英文|中文|例句|序号|词|解释|翻译|word|words|pos|ipa|meaning|translation|chinese|english|part\s*of\s*speech|phonetic|example|no\.?)$/i;

/**
 * 判断某一行是不是表头。
 * 不能只看"是否全英文"—— 三列表头 "Word | POS | Chinese" 全是英文。
 * 综合三条：命中表头词 / 翻译列没有中文 / 英文列本身就是标签。
 */
function isHeaderRow(cells, roles) {
  const wordCell = roles.word >= 0 ? (cells[roles.word] || '').trim() : '';
  const transCell = roles.translation >= 0 ? (cells[roles.translation] || '').trim() : '';

  if (wordCell && HEADER_WORDS.test(wordCell)) return true;
  if (transCell && HEADER_WORDS.test(transCell)) return true;
  if (roles.translation >= 0 && transCell && !hasChinese(transCell)) return true;
  if (roles.pos >= 0) {
    const posCell = (cells[roles.pos] || '').trim();
    if (posCell && HEADER_WORDS.test(posCell)) return true;
  }
  return false;
}

/** 用识别到的列角色，把一个表格转成候选记录 */
export function rowsFromTable(tableRows, mapping) {
  const out = [];
  const { roles } = mapping;

  tableRows.forEach((cells, idx) => {
    // 只可能第一行是表头
    if (idx === 0 && isHeaderRow(cells, roles)) return;

    const pick = (i) => (i >= 0 && i < cells.length ? (cells[i] || '').trim() : '');

    const wordCell = pick(roles.word);
    if (!wordCell) return;

    // 一个单元格里可能塞了多个词，用分隔符再切一次
    const wordParts = wordCell.split(/[\s,;:：，；、|]+/).filter(Boolean);
    const issues = [];
    let score = 1;

    let word = wordCell;
    if (wordParts.length > 1) {
      if (isEnglishWord(wordCell)) {
        // "apple pie" 这类词组，保留整体
      } else {
        word = wordParts[0];
        issues.push('该单元格含多个词，已取第一个');
        score = Math.min(score, 0.6);
      }
    }
    if (!isEnglishWord(word)) { issues.push('英文列内容异常'); score = Math.min(score, 0.4); }

    const transRaw = pick(roles.translation);
    const posFromTrans = extractPos(transRaw);
    const posFromCol = roles.pos >= 0 ? extractPos(pick(roles.pos)) : [];

    const ipaCells = roles.ipa.map((c) => pick(c)).filter(Boolean);
    const uk = ipaCells[0] ? cleanIpa(ipaCells[0]) : '';
    const us = ipaCells[1] ? cleanIpa(ipaCells[1]) : '';

    const example = roles.example >= 0 ? pick(roles.example) : '';

    if (!transRaw) { issues.push('缺少中文释义'); score = Math.min(score, 0.5); }

    out.push({
      raw: cells.join(' | '),
      word,
      translation: cleanTranslation(stripPosPrefix(transRaw)),
      pos: posFromCol.length ? posFromCol : posFromTrans,
      ukIpa: uk,
      usIpa: us,
      example,
      exampleTranslation: '',
      score,
      issues,
    });
  });
  return out;
}

/* ================================================================
 *  对外统一入口
 * ================================================================ */

/** 解析粘贴文本 */
export function parsePastedText(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const rows = [];
  for (const line of lines) {
    const r = parseLine(line);
    if (r && (r.word || r.translation)) rows.push(r);
  }
  return rows;
}

/**
 * 解析 docx 文档
 * @param {ArrayBuffer|Uint8Array} buf
 * @param {Function} unzipSync  fflate.unzipSync
 */
export function parseDocxBuffer(buf, unzipSync) {
  let xml;
  try {
    xml = extractDocumentXml(buf, unzipSync);
  } catch (e) {
    return { rows: [], error: '文件已损坏或不是有效的 .docx（无法解压）：' + (e.message || e), tables: 0, paragraphs: 0 };
  }
  if (!xml) {
    return { rows: [], error: '这不是有效的 .docx 文件（找不到 word/document.xml）', tables: 0, paragraphs: 0 };
  }
  const { tables, paragraphs } = extractDocxContent(xml);
  const rows = [];
  let usedTable = 0;

  for (const table of tables) {
    if (!table.length) continue;
    // 过滤全空行
    const clean = table
      .map((r) => r.map((c) => (c || '').trim()))
      .filter((r) => r.some((c) => c));
    if (clean.length < 1) continue;

    const mapping = detectColumnRoles(clean);
    if (mapping.roles.word < 0) continue;         // 这个表看着不像词表
    usedTable++;
    rows.push(...rowsFromTable(clean, mapping));
  }

  let usedPara = 0;
  for (const p of paragraphs) {
    const r = parseLine(p);
    if (r && r.word) { rows.push(r); usedPara++; }
  }

  if (!rows.length) {
    return {
      rows: [],
      error: '文档里没有识别到「英文 + 中文释义」形式的词条',
      tables: tables.length,
      paragraphs: paragraphs.length,
    };
  }
  return { rows, tables: usedTable, paragraphs: usedPara };
}

/**
 * 同一批导入内部的去重与合并
 *
 * 规则：
 *   · 单词按 normalizeWord 去重
 *   · 中文释义按「义项原子」求并集 —— 不能用子串判断，
 *     否则 "苹果, 苹果树" 会因为包含 "苹果" 被整条丢掉
 *   · 词性求并集（同一个词可同时是名词和动词）
 *   · 完全重复的整行计入 duplicates 统计
 */
export function mergeRows(rows) {
  const map = new Map();
  const dupes = [];

  for (const r of rows) {
    const key = normalizeWord(r.word);
    if (!key) continue;

    const atoms = splitSenses(r.translation);

    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        ...r,
        key,
        display: r.word.trim(),
        posSet: new Set(r.pos || []),
        senseAtoms: atoms.slice(),
        firstRaw: r.raw,
        duplicateCount: 1,
      });
      continue;
    }

    existing.duplicateCount++;
    dupes.push(r.raw);
    (r.pos || []).forEach((p) => existing.posSet.add(p));

    for (const a of atoms) {
      // 只按「完全相同」去重。用相似度会把 "苹果树" 当成 "苹果" 的重复而丢掉
      const dup = existing.senseAtoms.some((x) => x === a);
      if (!dup) existing.senseAtoms.push(a);
    }

    if (!existing.ukIpa && r.ukIpa) existing.ukIpa = r.ukIpa;
    if (!existing.usIpa && r.usIpa) existing.usIpa = r.usIpa;
    if (!existing.example && r.example) existing.example = r.example;
    if (!existing.exampleTranslation && r.exampleTranslation) existing.exampleTranslation = r.exampleTranslation;
    if (r.score > existing.score) existing.score = r.score;
  }

  const merged = [...map.values()].map((r) => ({
    ...r,
    pos: [...r.posSet],
    translation: r.senseAtoms.join('；'),
  }));

  return { rows: merged, duplicates: dupes.length };
}
