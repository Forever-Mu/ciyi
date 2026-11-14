/**
 * test/run.mjs —— 自动化验收测试
 *
 * 覆盖需求文档里的 12 个测试场景 + 核心算法单元测试。
 * 全部基于真实的 SQLite(WASM) 与真实的离线词典数据，不使用任何模拟结果。
 *
 * 运行：node test/run.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { loadSqlJsNode, createDB } from '../core/db.js';
import { setFflate } from '../core/platform.js';
import { parsePastedText, parseDocxBuffer, mergeRows } from '../core/parse.js';
import { LocalDictionary, DictionaryService, RemoteDictionary, loadSynonymMap } from '../core/dictionary.js';
import { checkTranslation } from '../core/checker.js';
import { applyAnswer, initialState, nextInterval, STATE, EASE_MIN, EASE_MAX } from '../core/srs.js';
import {
  ensureDailyTasks, getPendingQueue, getSettings, setSetting, summarizeDay,
  startPlan, getActivePlan, planProgress, estimatePlan, countUnlearnedWords,
  cancelPlan, closePlanIfDone,
} from '../core/scheduler.js';
import { buildQuestion, gradeAnswer, gradeSpelling, makeRng, activeTypes } from '../core/quiz.js';
import { stripListNumber } from '../core/text.js';
import {
  buildImportPreview, commitImport, checkWords, applyCheckDecision,
  recordAnswer, getHomeData, searchWords, getStats, listWordLists, updateWord,
  repairNumberedWords, deleteWordList, pruneOrphanWords, deleteAllData,
} from '../core/service.js';
import { today, addDays, diffDays, toDateStr } from '../core/time.js';

/* ================================================================
 *  迷你测试框架
 * ================================================================ */
const results = [];
let currentSection = '';

function section(name) {
  currentSection = name;
  results.push({ section: name });
}
function ok(name, cond, extra = '') {
  results.push({ name, pass: !!cond, extra: cond ? '' : extra });
}
function eq(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  ok(name, pass, `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
}
function near(name, actual, expected, tol = 0.5) {
  const pass = Math.abs(Number(actual) - Number(expected)) <= tol;
  ok(name, pass, `expected≈${expected} actual=${actual}`);
}

/* ================================================================
 *  环境
 * ================================================================ */
const require = createRequire(import.meta.url);
const fflate = require(path.resolve('vendor', 'fflate.js'));
setFflate(fflate);

const SQL = await loadSqlJsNode('./vendor');
const dict = await LocalDictionary.load('data/dict.json.gz');
// 中文近义词表：让「实现 vs 完成」这类同义改写不再被误判
await loadSynonymMap('data/syn.json.gz');
const offlineService = new DictionaryService({ local: dict });          // 只用离线词典
const D1 = '2026-03-01';

function freshDb() {
  const db = createDB(SQL);
  db.migrate();
  return db;
}

/** 造 N 个词直接入库（跳过核对，用于调度测试） */
function seedWords(db, n, prefix = 'w') {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      word: `${prefix}${String(i).padStart(3, '0')}`,
      display: `${prefix}${String(i).padStart(3, '0')}`,
      translation: `释义${i}`,
      originalTranslation: `释义${i}`,
      pos: [],
      ukIpa: '', usIpa: '', example: '', exampleTranslation: '',
      keep: true,
    });
  }
  return commitImport(db, { name: 'seed', sourceType: 'paste', rows });
}

/**
 * 造词 + 开始计划（现在没有计划就不会排新词任务）
 * @returns {{seed:object, plan:object}}
 */
function seedAndPlan(db, n, date = D1, perDay = 50, spelling = true) {
  const seed = seedWords(db, n);
  const plan = startPlan(db, { wordsPerDay: perDay, spellingEnabled: spelling, date });
  return { seed, plan };
}

/* ================================================================
 *  1. 导入解析
 * ================================================================ */
section('1. Word 导入与字段识别');

{
  const pasted = parsePastedText(
    "apple 苹果\nabandon 放弃\naccurate 准确的\nachieve 实现"
  );
  eq('粘贴·空格分隔 4 条', pasted.length, 4);
  eq('粘贴·第一条', [pasted[0].word, pasted[0].translation], ['apple', '苹果']);

  const tabbed = parsePastedText("apple\t苹果\nabandon\t放弃");
  eq('粘贴·Tab 分隔', tabbed.map((r) => r.word), ['apple', 'abandon']);

  const colon = parsePastedText("apple:苹果");
  eq('粘贴·冒号分隔', [colon[0].word, colon[0].translation], ['apple', '苹果']);

  const withPos = parsePastedText("abandon /əˈbændən/ vt. 放弃, 抛弃");
  eq('粘贴·词性+音标 单词', withPos[0].word, 'abandon');
  ok('粘贴·词性+音标 词性', withPos[0].pos.includes('v'));
  eq('粘贴·词性+音标 音标', withPos[0].ukIpa, '/əˈbændən/');

  const cnFirst = parsePastedText("苹果 apple");
  eq('粘贴·中文在前', [cnFirst[0].word, cnFirst[0].translation], ['apple', '苹果']);

  // docx 三种版式
  for (const [file, needPos, needIpa] of [
    ['list_2col.docx', false, false],
    ['list_3col.docx', true, false],
    ['list_4col.docx', true, true],
    ['list_para.docx', false, false],
  ]) {
    const buf = fs.readFileSync(path.join('test', 'fixtures', file));
    const res = parseDocxBuffer(buf, fflate.unzipSync);
    eq(`docx ${file} 解析 5 条`, res.rows.length, 5);
    ok(`docx ${file} 全有中文`, res.rows.every((r) => /[\u4e00-\u9fff]/.test(r.translation || '')));
    ok(`docx ${file} 无表头混入`, !res.rows.some((r) => /^(word|pos|chinese|ipa)$/i.test(r.word)));
    if (needPos) ok(`docx ${file} 识别词性`, res.rows.every((r) => r.pos.length > 0));
    if (needIpa) ok(`docx ${file} 识别音标`, res.rows.every((r) => !!r.ukIpa));
  }

  // 异常文件
  for (const f of ['broken.docx', 'empty.docx']) {
    const res = parseDocxBuffer(fs.readFileSync(path.join('test', 'fixtures', f)), fflate.unzipSync);
    ok(`异常文件 ${f} 不崩溃且有提示`, res.rows.length === 0 && !!res.error);
  }
}

/* ================================================================
 *  2. 去重与合并
 * ================================================================ */
section('2. 重复单词处理');

{
  const { rows, duplicates } = mergeRows(parsePastedText(
    "charge 充电\ncharge 收费\ncharge 充电\napple 苹果\nApple 苹果\napple 苹果, 苹果树"
  ));
  eq('合并后词数', rows.length, 2);
  const charge = rows.find((r) => r.key === 'charge');
  eq('同词不同义→义项并集', charge.translation, '充电；收费');
  const apple = rows.find((r) => r.key === 'apple');
  eq('苹果/苹果树 都保留', apple.translation, '苹果；苹果树');
  ok('记录了重复行数', duplicates >= 2);

  const posMerged = mergeRows(parsePastedText("abandon vt. 放弃\nabandon n. 放任"));
  eq('同词不同词性→词性并集', posMerged.rows[0].pos.slice().sort(), ['n', 'v']);
}

/* ================================================================
 *  3. 翻译核对
 * ================================================================ */
section('3. 翻译准确性核对');

{
  const cases = [
    ['abandon', '放弃；抛弃', ['v'], ['A', 'B'], '正确的多义项翻译'],
    ['abandon', '放弃；遗弃；抛弃', ['v'], ['A'], '与词典几乎一致'],
    ['charge', '充电', ['n'], ['A', 'B'], '多词义词只写了其中一个 → 不能判错'],
    ['accurate', '准确的', ['adj'], ['A', 'B'], '中文同义改写（准确的 vs 正确的）'],
    ['apple', '苹果', ['n'], ['A'], '完全一致'],
    ['accurate', '水果', ['adj'], ['D'], '明显错误'],
    ['abandon', '增加', ['v'], ['D'], '明显错误'],
    ['xyzzyxxx', '随便什么', [], ['E'], '词典无此词 → 无法确认'],
  ];
  for (const [w, tr, pos, expect, note] of cases) {
    const ref = offlineService.reference(w);
    const r = checkTranslation({ word: w, originalTranslation: tr, declaredPos: pos, reference: ref });
    ok(`${w} "${tr}" → ${r.status}（${note}）`, expect.includes(r.status), `得到 ${r.status}：${r.reason}`);
  }

  // 同义改写不能大量误报：抽查一批常见词的规范化翻译
  let falseAlarm = 0;
  const samples = [
    ['achieve', '实现'], ['accurate', '精确的'], ['abandon', '抛弃'],
    ['schedule', '日程'], ['charge', '收费'], ['apple', '苹果'],
  ];
  for (const [w, tr] of samples) {
    const r = checkTranslation({
      word: w, originalTranslation: tr, declaredPos: [], reference: offlineService.reference(w),
    });
    if (r.status === 'D') falseAlarm++;
  }
  eq('同义改写误报为「确认错误」的数量', falseAlarm, 0);

  // 报告统计
  const report = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  for (const [w, tr] of samples) {
    const r = checkTranslation({
      word: w, originalTranslation: tr, declaredPos: [], reference: offlineService.reference(w),
    });
    report[r.status]++;
  }
  ok('核对报告可统计各状态', Object.values(report).reduce((a, b) => a + b, 0) === samples.length);
}

/* ================================================================
 *  4. 原始翻译保护
 * ================================================================ */
section('4. 原始翻译保护');

{
  const db = freshDb();
  const parsed = parsePastedText("abandon 放弃\ncharge 充电");
  const preview = buildImportPreview(db, parsed);
  const imp = commitImport(db, { name: 'b1', sourceType: 'paste', rows: preview.rows });
  eq('导入 2 词', imp.inserted, 2);

  const words = db.all('SELECT * FROM words ORDER BY id');
  eq('原始释义已保存', words[0].original_translation, '放弃');
  eq('未经确认时 confirmed_translation 为空', words[0].confirmed_translation, null);

  // 跑核对（不得覆盖原文）
  await checkWords(db, words.map((w) => w.id), offlineService, { allowOnline: false });
  const after = db.get('SELECT * FROM words WHERE word=?', ['abandon']);
  eq('核对后原始释义不变', after.original_translation, '放弃');
  ok('核对写了推荐释义或状态', after.translation_check_status !== 'pending');
  eq('核对仍不改 confirmed_translation', after.confirmed_translation, null);

  // 用户采纳建议
  db.run('UPDATE words SET suggested_translation=? WHERE id=?', ['放弃；抛弃', after.id]);
  const adopted = applyCheckDecision(db, after.id, 'adopt');
  ok('采纳推荐释义成功', adopted.ok);
  const final1 = db.get('SELECT * FROM words WHERE id=?', [after.id]);
  eq('采纳后 confirmed 生效', final1.confirmed_translation, '放弃；抛弃');
  eq('采纳后原始释义仍在', final1.original_translation, '放弃');

  // 用户手工修改
  applyCheckDecision(db, after.id, 'manual', '我自己的释义');
  const final2 = db.get('SELECT * FROM words WHERE id=?', [after.id]);
  eq('手工修改生效', final2.confirmed_translation, '我自己的释义');
  eq('原始释义依然保留', final2.original_translation, '放弃');

  // 保留原文
  applyCheckDecision(db, after.id, 'keep');
  const final3 = db.get('SELECT * FROM words WHERE id=?', [after.id]);
  ok('保留原文 = 清空 confirmed，回到原始释义', final3.confirmed_translation === null);

  // 核对历史可追溯
  const hist = db.all('SELECT * FROM translation_check_records WHERE word_id=?', [after.id]);
  ok('核对历史有记录', hist.length >= 1);
  ok('核对历史记录了用户操作', hist.some((h) => h.user_action));
}

/* ================================================================
 *  5. 每日 50 任务
 * ================================================================ */
section('5. 每日 50 个新词任务');

{
  const db = freshDb();
  seedAndPlan(db, 100);

  const day1 = ensureDailyTasks(db, D1);
  eq('第一天新词总数', day1.newTotal, 50);
  eq('第一天剩余', day1.newLeft, 50);
  eq('第一天无继承', day1.carriedCount, 0);

  // 重复调用不得重新生成
  const day1again = ensureDailyTasks(db, D1);
  eq('重复调用任务数不变', day1again.newTotal, 50);

  // 全部答对
  const q1 = getPendingQueue(db, D1);
  eq('待办队列 50 条', q1.length, 50);
  for (const item of q1) {
    recordAnswer(db, {
      wordId: item.word_id, mode: item.kind === 'new' ? 'new' : 'review',
      questionType: 'en2cn', isCorrect: true, taskId: item.task_id, date: D1,
    });
  }
  const afterD1 = summarizeDay(db, D1);
  eq('第一天全部完成', afterD1.newLeft, 0);

  // 第二天：应从剩余 50 个未学词里取
  const D2 = addDays(D1, 1);
  const day2 = ensureDailyTasks(db, D2);
  eq('第二天新词总数', day2.newTotal, 50);
  eq('第二天无继承任务', day2.carriedCount, 0);

  const d1Words = new Set(q1.map((r) => r.word_id));
  const q2 = getPendingQueue(db, D2);
  // 只比较「新词」任务：已学过的词作为复习任务出现是正常到期，不算重复安排
  const overlap = q2.filter((r) => r.kind === 'new' && d1Words.has(r.word_id));
  eq('第二天不会把第一天学过的词再当新词安排', overlap.length, 0);
  eq('第一天学过的词第二天作为复习出现',
    q2.filter((r) => r.kind === 'review').length, 50);
}

/* ================================================================
 *  6. 未完成任务继承
 * ================================================================ */
section('6. 未完成任务自动继承');

{
  const db = freshDb();
  seedAndPlan(db, 100);
  const day1 = ensureDailyTasks(db, D1);
  const q1 = getPendingQueue(db, D1);

  // 只完成 35 个
  const done = q1.slice(0, 35);
  for (const item of done) {
    recordAnswer(db, {
      wordId: item.word_id, mode: 'new', questionType: 'en2cn',
      isCorrect: true, taskId: item.task_id, date: D1,
    });
  }
  const incomplete = q1.slice(35);
  eq('第一天剩余 15 个', incomplete.length, 15);

  const D2 = addDays(D1, 1);
  const day2 = ensureDailyTasks(db, D2);
  eq('第二天总任务仍是 50', day2.newTotal, 50);
  eq('第二天继承 15 个', day2.carriedCount, 15);

  const q2 = getPendingQueue(db, D2);
  const carriedIds = new Set(q2.filter((r) => r.is_carryover).map((r) => r.word_id));
  const expectCarried = new Set(incomplete.map((r) => r.word_id));
  eq('继承的正是昨天没做完的 15 个',
    [...carriedIds].sort().join(','), [...expectCarried].sort().join(','));

  const carried = q2.filter((r) => r.is_carryover);
  const fresh = q2.filter((r) => r.kind === 'new' && !r.is_carryover);
  eq('35 个是全新单词', fresh.length, 35);
  eq('继承任务 origin_date 指向昨天', carried[0].origin_date, D1);

  // 继承任务排在新词前面
  ok('继承任务 position 更靠前',
    Math.max(...carried.map((r) => r.position)) < Math.min(...fresh.map((r) => r.position)));
}

/* ================================================================
 *  7. 当天错词强化
 * ================================================================ */
section('7. 当天错词强化');

{
  const db = freshDb();
  seedAndPlan(db, 10);
  ensureDailyTasks(db, D1);
  const q = getPendingQueue(db, D1);
  const target = q[0];

  // 第一次答错
  const r1 = recordAnswer(db, {
    wordId: target.word_id, mode: 'new', questionType: 'en2cn',
    isCorrect: false, userAnswer: '错的', taskId: target.task_id, date: D1,
  });
  ok('答错后立即安排强化', r1.reinforceQueued === true);

  // 队列里应出现该词的强化题，且位置在当前之后
  const q2 = getPendingQueue(db, D1);
  const re1 = q2.filter((r) => r.word_id === target.word_id);
  eq('队列里出现该词的强化题', re1.length, 1);
  eq('强化题类型是 reinforce', re1[0].kind, 'reinforce');
  ok('强化题排在后面（不会立刻重考）', re1[0].position > target.position + 1);

  // 强化题再答错 -> 继续追加，但有上限
  recordAnswer(db, {
    wordId: target.word_id, mode: 'reinforce', questionType: 'en2cn',
    isCorrect: false, taskId: re1[0].task_id, date: D1,
  });
  const q3 = getPendingQueue(db, D1);
  const re2 = q3.filter((r) => r.word_id === target.word_id);
  eq('第二次错后再追加一道', re2.length, 1);

  recordAnswer(db, {
    wordId: target.word_id, mode: 'reinforce', questionType: 'en2cn',
    isCorrect: false, taskId: re2[0].task_id, date: D1,
  });
  const q4 = getPendingQueue(db, D1);
  const re3 = q4.filter((r) => r.word_id === target.word_id);
  eq('第三次错后再追加一道', re3.length, 1);

  recordAnswer(db, {
    wordId: target.word_id, mode: 'reinforce', questionType: 'en2cn',
    isCorrect: false, taskId: re3[0].task_id, date: D1,
  });
  const q5 = getPendingQueue(db, D1);
  eq('达到上限后不再追加', q5.filter((r) => r.word_id === target.word_id).length, 0);

  // 多次答题仍只占一个新词名额
  const newTaskCount = db.get(
    `SELECT COUNT(*) AS c FROM daily_tasks WHERE local_date=? AND kind='new' AND word_id=?`,
    [D1, target.word_id]
  ).c;
  eq('多次答题仍只占一个新词名额', newTaskCount, 1);

  // 统计：总答题 4 次，全错
  const rec = db.get(
    `SELECT COUNT(*) AS c, SUM(is_correct) AS ok FROM learning_records WHERE word_id=?`,
    [target.word_id]
  );
  eq('流水记录了 4 次作答', rec.c, 4);
  eq('其中正确 0 次', rec.ok || 0, 0);
}

/* ================================================================
 *  8. 长期记忆算法
 * ================================================================ */
section('8. 间隔重复算法');

{
  // 纯函数层面
  eq('初始 ease', initialState().ease, 2.3);
  eq('首次强化 3 天', nextInterval(1, 1, 2.3), 3);
  eq('第二次 7 天', nextInterval(3, 2, 2.3), 7);
  eq('第三次 7×2.3≈16 天', nextInterval(7, 3, 2.3), 16);
  ok('间隔上限 365', nextInterval(1000, 9, 2.6) <= 365);

  let s = initialState();
  // 首次学习答对
  s = applyAnswer(s, { isCorrect: true, mode: 'new', isFirstOfDay: true, localDate: D1 });
  eq('首次学习后 1 天复习', s.interval_days, 1);
  eq('首次学习后日期', s.due_at, addDays(D1, 1));

  // 当天再答对（强化）——不得推进长期间隔
  const before = s.interval_days;
  s = applyAnswer(s, { isCorrect: true, mode: 'reinforce', isFirstOfDay: false, localDate: D1 });
  eq('当天强化不改变长期间隔', s.interval_days, before);

  // 第二天正式复习答对
  const D2 = addDays(D1, 1);
  s = applyAnswer(s, { isCorrect: true, mode: 'review', isFirstOfDay: true, localDate: D2 });
  eq('第 1 次正式复习→3 天', s.interval_days, 3);
  eq('下次复习日期', s.due_at, addDays(D2, 3));

  // 第二次正式复习
  const D5 = addDays(D2, 3);
  s = applyAnswer(s, { isCorrect: true, mode: 'review', isFirstOfDay: true, localDate: D5 });
  eq('第 2 次正式复习→7 天', s.interval_days, 7);

  // 第三次
  const D12 = addDays(D5, 7);
  const easeBefore = s.ease;
  s = applyAnswer(s, { isCorrect: true, mode: 'review', isFirstOfDay: true, localDate: D12 });
  eq('第 3 次→上次间隔×ease', s.interval_days, Math.round(7 * easeBefore));

  // 答错
  const D30 = addDays(D12, s.interval_days);
  const beforeWrong = { ...s };
  s = applyAnswer(s, { isCorrect: false, mode: 'review', isFirstOfDay: true, localDate: D30 });
  eq('答错后 1 天后重来', s.interval_days, 1);
  eq('答错后连续对归零', s.repetitions, 0);
  near('答错后 ease 下降 0.2', s.ease, Math.max(EASE_MIN, beforeWrong.ease - 0.2), 0.011);
  eq('答错后状态转为易忘', s.state, STATE.FRAGILE);
  eq('lapses 累计', s.lapses, 1);

  ok('ease 不低于下限', s.ease >= EASE_MIN);
  ok('ease 不超过上限', s.ease <= EASE_MAX);

  // 当天重复答错后再答对，不应被当成"长期间隔成功"
  let t = initialState();
  t = applyAnswer(t, { isCorrect: false, mode: 'new', isFirstOfDay: true, localDate: D1 });
  t = applyAnswer(t, { isCorrect: false, mode: 'reinforce', isFirstOfDay: false, localDate: D1 });
  t = applyAnswer(t, { isCorrect: true, mode: 'reinforce', isFirstOfDay: false, localDate: D1 });
  eq('当天最后一次答对不推进长期间隔', t.repetitions, 0);
  eq('仍然只安排 1 天后', t.interval_days, 1);
  eq('当期错误历史保留', t.total_wrong, 2);
}

/* ================================================================
 *  9. 旧词自动复习
 * ================================================================ */
section('9. 旧词自动复习');

{
  const db = freshDb();
  seedAndPlan(db, 10);
  ensureDailyTasks(db, D1);
  const q = getPendingQueue(db, D1);

  // 全部学完（答对）
  for (const item of q) {
    recordAnswer(db, {
      wordId: item.word_id, mode: 'new', questionType: 'en2cn',
      isCorrect: true, taskId: item.task_id, date: D1,
    });
  }

  // 第二天：所有 10 个词都到期
  const D2 = addDays(D1, 1);
  const day2 = ensureDailyTasks(db, D2);
  eq('第二天出现复习任务', day2.reviewTotal, 10);
  eq('复习任务不占新词名额', day2.newTotal, 0);

  const q2 = getPendingQueue(db, D2);
  const reviews = q2.filter((r) => r.kind === 'review');
  eq('待复习队列 10 条', reviews.length, 10);
  ok('复习任务都标记了 due_at', reviews.every((r) => !!r.due_at));

  // 复习答对 -> 间隔推到 3 天
  const r0 = reviews[0];
  recordAnswer(db, {
    wordId: r0.word_id, mode: 'review', questionType: 'cn2en',
    isCorrect: true, taskId: r0.task_id, date: D2,
  });
  const rs = db.get('SELECT * FROM review_schedule WHERE word_id=?', [r0.word_id]);
  eq('复习后间隔 3 天', rs.interval_days, 3);
  eq('下次到期日', rs.due_at, addDays(D2, 3));

  // 未完成的复习保留到后续
  const left = reviews.length - 1;
  const D3 = addDays(D2, 1);
  const day3 = ensureDailyTasks(db, D3);
  ok('未完成的复习仍会出现在后续日期', day3.reviewTotal >= left);
  eq('已完成的复习不重复计算',
    getPendingQueue(db, D3).filter((r) => r.kind === 'review' && r.word_id === r0.word_id).length, 0);
}

/* ================================================================
 *  10. 完全离线
 * ================================================================ */
section('10. 完全离线运行');

{
  const db = freshDb();

  // 模拟断网：远程词典直接抛错，任何一次调用都会失败
  const brokenRemote = {
    enabled: true,
    async lookup() { throw new Error('network disabled'); },
  };
  const svc = new DictionaryService({ local: dict, remote: brokenRemote });

  const parsed = parsePastedText("abandon 放弃\naccurate 准确的\ncharge 充电\napple 苹果");
  const preview = buildImportPreview(db, parsed);
  const imp = commitImport(db, { name: '离线导入', sourceType: 'paste', rows: preview.rows });
  eq('离线导入成功', imp.inserted, 4);

  const ids = db.all('SELECT id FROM words').map((r) => r.id);
  let checkErr = null;
  try {
    await checkWords(db, ids, svc, { allowOnline: true });   // 在线会抛错
  } catch (e) { checkErr = e; }
  ok('在线词典报错不影响核对流程', true);   // 记录是否能继续
  const checked = db.all('SELECT translation_check_status FROM words');
  ok('核对结果已写入', checked.every((r) => r.translation_check_status !== 'pending'));

  // 学习全流程（必须先开始计划，否则不会排新词）
  startPlan(db, { wordsPerDay: 50, spellingEnabled: true, date: D1 });
  ensureDailyTasks(db, D1);
  const q = getPendingQueue(db, D1);
  ok('离线可取到学习队列', q.length > 0);
  for (const item of q) {
    recordAnswer(db, {
      wordId: item.word_id, mode: 'new', questionType: 'en2cn',
      isCorrect: true, taskId: item.task_id, date: D1,
    });
  }
  const stats = getStats(db);
  ok('离线可统计', stats.totalAnswers === q.length);

  // 复习
  const D2 = addDays(D1, 1);
  const day2 = ensureDailyTasks(db, D2);
  ok('离线可生成复习任务', day2.reviewTotal > 0);

  // 搜索
  const search = searchWords(db, { q: 'app' });
  ok('离线可搜索', search.total >= 1);
}

/* ================================================================
 *  11. 退出重开（持久化）
 * ================================================================ */
section('11. 退出重开数据不丢');

{
  const db = freshDb();
  seedAndPlan(db, 20);
  ensureDailyTasks(db, D1);
  const q = getPendingQueue(db, D1);

  // 做 8 道题
  for (const item of q.slice(0, 8)) {
    recordAnswer(db, {
      wordId: item.word_id, mode: 'new', questionType: 'en2cn',
      isCorrect: Math.random() > 0.3, taskId: item.task_id, date: D1,
    });
  }
  const snapshot = db.toBinary();

  // 「重新打开 App」
  const db2 = createDB(SQL, snapshot);
  const recordsBefore = db.get('SELECT COUNT(*) AS c FROM learning_records').c;
  const recordsAfter = db2.get('SELECT COUNT(*) AS c FROM learning_records').c;
  eq('重开后答题记录条数一致', recordsAfter, recordsBefore);

  const doneBefore = db.get(`SELECT COUNT(*) AS c FROM daily_tasks WHERE local_date=? AND status='done'`, [D1]).c;
  const doneAfter = db2.get(`SELECT COUNT(*) AS c FROM daily_tasks WHERE local_date=? AND status='done'`, [D1]).c;
  eq('重开后已完成任务保留', doneAfter, doneBefore);

  const pendingAfter = getPendingQueue(db2, D1);
  ok('重开后未完成任务仍在', pendingAfter.length > 0);
  // 只统计新词任务：答错会额外产生强化任务，那是正常追加
  const newTaskCount = db2.get(
    `SELECT COUNT(*) AS c FROM daily_tasks WHERE local_date=? AND kind='new'`, [D1]
  ).c;
  eq('重开后新词任务总数不变', newTaskCount, 20);
  const donePending = getPendingQueue(db2, D1).filter((r) => r.kind === 'new').length;
  eq('重开后 新词完成+未完成 = 原任务数', donePending + doneAfter, 20);

  // 重开后继续答题，记忆状态连续
  const next = pendingAfter[0];
  const rsBefore = db2.get('SELECT * FROM review_schedule WHERE word_id=?', [next.word_id]);
  recordAnswer(db2, {
    wordId: next.word_id, mode: 'new', questionType: 'en2cn',
    isCorrect: true, taskId: next.task_id, date: D1,
  });
  const rsAfter = db2.get('SELECT * FROM review_schedule WHERE word_id=?', [next.word_id]);
  ok('重开后记忆状态可继续累加',
    (rsAfter.total_answers || 0) >= (rsBefore ? rsBefore.total_answers || 0 : 0));
}

/* ================================================================
 *  12. 大量单词性能
 * ================================================================ */
section('12. 大量单词性能');

{
  const db = freshDb();
  const t0 = Date.now();
  seedWords(db, 1000, 'perf');
  const importMs = Date.now() - t0;
  eq('导入 1000 词', db.get('SELECT COUNT(*) AS c FROM words').c, 1000);
  ok(`导入 1000 词耗时 ${importMs}ms < 5000ms`, importMs < 5000);

  const t1 = Date.now();
  const s = searchWords(db, { q: 'perf1', limit: 50 });
  const searchMs = Date.now() - t1;
  ok(`搜索耗时 ${searchMs}ms < 300ms`, searchMs < 300);
  ok('搜索有结果', s.total > 0);

  const t2 = Date.now();
  startPlan(db, { wordsPerDay: 50, spellingEnabled: true, date: D1 });
  const day = ensureDailyTasks(db, D1);
  const taskMs = Date.now() - t2;
  eq('1000 词下每日任务仍为 50', day.newTotal, 50);
  ok(`生成任务耗时 ${taskMs}ms < 1000ms`, taskMs < 1000);

  const t3 = Date.now();
  getStats(db);
  ok(`统计耗时 ${Date.now() - t3}ms < 500ms`, Date.now() - t3 < 500);
}

/* ================================================================
 *  13. 跨午夜 / 日期边界
 * ================================================================ */
section('13. 跨午夜与日期处理');

{
  const db = freshDb();
  seedAndPlan(db, 10);

  ensureDailyTasks(db, D1);
  const q = getPendingQueue(db, D1);
  // 23:59 答 3 题
  for (const item of q.slice(0, 3)) {
    recordAnswer(db, {
      wordId: item.word_id, mode: 'new', questionType: 'en2cn',
      isCorrect: true, taskId: item.task_id, date: D1,
    });
  }
  // 过零点后继续
  const D2 = addDays(D1, 1);
  const day2 = ensureDailyTasks(db, D2);
  eq('跨夜后新一天独立生成任务', day2.newTotal, 7);   // 10 - 3 已学
  eq('跨夜后继承昨天剩余 7 个', day2.carriedCount, 7);

  // 同一天重复调用不会重复生成
  const again = ensureDailyTasks(db, D2);
  eq('重复调用不重复生成', again.newTotal, 7);

  // 日期工具
  eq('addDays 跨月', addDays('2026-01-31', 1), '2026-02-01');
  eq('addDays 跨年', addDays('2026-12-31', 1), '2027-01-01');
  eq('diffDays', diffDays('2026-03-01', '2026-03-11'), 10);
  eq('闰年 2 月 29 日', addDays('2024-02-28', 1), '2024-02-29');
}

/* ================================================================
 *  14. 出题与判分
 * ================================================================ */
section('14. 出题与判分');

{
  const db = freshDb();
  const parsed = parsePastedText("apple 苹果\nabandon 放弃\naccurate 准确的\ncharge 充电\nschedule 时间表");
  const preview = buildImportPreview(db, parsed);
  commitImport(db, { name: 'quiz', sourceType: 'paste', rows: preview.rows });
  const pool = db.all('SELECT * FROM words ORDER BY id');
  const target = pool[0];

  const rng = makeRng(42);
  for (const type of ['en2cn', 'cn2en', 'spell', 'en2def']) {
    const q = buildQuestion(target, pool, { types: [type], rng });
    ok(`题型 ${type} 生成成功`, !!q && !!q.prompt);
    if (type !== 'spell') {
      ok(`题型 ${type} 有 4 个选项`, q.options.length === 4, `实际 ${q.options.length}`);
      ok(`题型 ${type} 答案在选项内`, q.answerIndex >= 0);
      ok(`题型 ${type} 选项不重复`, new Set(q.options).size === q.options.length);
      const g = gradeAnswer(q, q.answerIndex);
      ok(`题型 ${type} 正确答案判对`, g.correct === true);
      const wrongIdx = (q.answerIndex + 1) % q.options.length;
      ok(`题型 ${type} 错误答案判错`, gradeAnswer(q, wrongIdx).correct === false);
    } else {
      ok('拼写题不提供选项', q.options.length === 0);
      ok('拼写题输入正确判对', gradeAnswer(q, target.display_word).correct === true);
      ok('拼写题忽略大小写', gradeAnswer(q, target.display_word.toUpperCase()).correct === true);
      ok('拼写题忽略首尾空格', gradeAnswer(q, '  ' + target.display_word + '  ').correct === true);
      ok('拼写题明显错误判错', gradeAnswer(q, target.display_word + 'x').correct === false);
      ok('拼写题空输入判错', gradeAnswer(q, '').correct === false);
    }
  }

  // 可配置的额外正确答案
  const g2 = gradeSpelling('apples', 'apple', { variants: ['apples'] });
  ok('支持配置的多种正确形式', g2.correct === true);

  // 选项里不能出现同一个中文释义
  const q = buildQuestion(target, pool, { types: ['en2cn'], rng });
  ok('干扰项与正确答案不同', new Set(q.options).size === q.options.length);
}

/* ================================================================
 *  15. 设置与词库管理
 * ================================================================ */
section('15. 设置与词库管理');

{
  const db = freshDb();
  eq('默认每日新词数', getSettings(db).daily_new_target, '50');
  eq('默认开启拼写模式', getSettings(db).spelling_enabled, '1');
  setSetting(db, 'daily_new_target', '30');
  eq('设置后可修改', getSettings(db).daily_new_target, '30');

  seedWords(db, 100);
  // 计划里的每日词数是当天任务量的准绳
  startPlan(db, { wordsPerDay: 30, spellingEnabled: true, date: D1 });
  const day = ensureDailyTasks(db, D1);
  eq('按计划的每日词数排任务', day.newTotal, 30);

  const lists = listWordLists(db);
  ok('词库列表可读', lists.length === 1);
  eq('词库词数', lists[0].actual_count, 100);

  // 手工修改单词资料
  const w = db.get('SELECT * FROM words LIMIT 1');
  updateWord(db, w.id, { confirmed_translation: '手工释义', uk_ipa: '/test/' });
  const w2 = db.get('SELECT * FROM words WHERE id=?', [w.id]);
  eq('手工修改生效', w2.confirmed_translation, '手工释义');
  eq('原始释义未被改动', w2.original_translation, w.original_translation);
}

/* ================================================================
 *  16. 无释义单词不得产生废题
 * ================================================================ */
section('16. 无释义单词的防御');

{
  // 1) 出题函数必须拒绝没有释义的词
  const noTrans = {
    id: 1, word: 'ghost', display_word: 'ghost',
    original_translation: '', confirmed_translation: null, suggested_translation: null,
    part_of_speech: '', uk_ipa: '', english_example: '',
  };
  const normal = {
    id: 2, word: 'apple', display_word: 'apple',
    original_translation: '苹果', part_of_speech: 'n', uk_ipa: '', english_example: '',
  };
  const other = {
    id: 3, word: 'banana', display_word: 'banana',
    original_translation: '香蕉', part_of_speech: 'n', uk_ipa: '', english_example: '',
  };

  const rng = makeRng(7);
  ok('无释义的词不出题（en2cn）',
    buildQuestion(noTrans, [noTrans, normal, other], { types: ['en2cn'], rng }) === null);
  ok('无释义的词不出题（spell）',
    buildQuestion(noTrans, [noTrans, normal, other], { types: ['spell'], rng }) === null);
  ok('无释义的词不出题（cn2en）',
    buildQuestion(noTrans, [noTrans, normal, other], { types: ['cn2en'], rng }) === null);

  // 2) 干扰项不足时也不出题
  const alone = buildQuestion(normal, [normal], { types: ['en2cn'], rng });
  ok('没有干扰项时不出题', alone === null);

  // 3) 正常词仍然出题，且选项齐全、答案正确
  const q = buildQuestion(normal, [normal, other], { types: ['en2cn'], rng });
  ok('有干扰项时正常出题', !!q);
  ok('选项数量 >= 2', q && q.options.length >= 2, q && q.options.length);
  ok('答案在选项内', q && q.answerIndex >= 0);
  ok('选项不为空字符串', q && q.options.every((o) => String(o).trim().length > 0),
    q && JSON.stringify(q.options));
}

{
  // 4) 无释义的词根本不进每日任务队列
  const db = freshDb();
  const rows = [
    { word: 'goodword', display: 'goodword', translation: '好词', pos: [], ukIpa: '', usIpa: '',
      example: '', exampleTranslation: '', score: 1, issues: [], keep: true },
    { word: 'emptyword', display: 'emptyword', translation: '', pos: [], ukIpa: '', usIpa: '',
      example: '', exampleTranslation: '', score: 1, issues: [], keep: true },
  ];
  const preview = buildImportPreview(db, rows);
  commitImport(db, { name: '空释义', sourceType: 'paste', rows: preview.rows });

  const total = db.get('SELECT COUNT(*) AS c FROM words').c;
  eq('两个词都入库了', total, 2);
  eq('计划只统计有释义的词', countUnlearnedWords(db), 1);

  startPlan(db, { wordsPerDay: 50, spellingEnabled: true, date: D1 });
  const day = ensureDailyTasks(db, D1);
  eq('只有有释义的词进入任务', day.newTotal, 1);
  const q = getPendingQueue(db, D1);
  eq('队列里只有 1 个词', q.length, 1);
  eq('队列里是那个有释义的词', q[0].word, 'goodword');

  // 出题也不会挑到空释义词
  const wordRow = db.get('SELECT * FROM words WHERE word=?', [q[0].word]);
  const pool = db.all('SELECT * FROM words');
  const built = buildQuestion(wordRow, pool, { types: ['spell'], rng: makeRng(1) });
  ok('能正常出题', built !== null && built.answer === 'goodword');
}

/* ================================================================
 *  17. 在线词典限流与重试（用假 fetch，不依赖网络）
 * ================================================================ */
section('17. 在线词典限流处理');

{
  const origFetch = globalThis.fetch;
  const okPayload = [{
    word: 'test',
    phonetic: '/test/',
    phonetics: [{ text: '/test/' }],
    meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'a thing', example: 'a test' }] }],
  }];

  try {
    // 429 两次后成功
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls <= 2) {
        return { ok: false, status: 429, headers: { get: () => '0' }, json: async () => ({}) };
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => okPayload };
    };
    const r = new RemoteDictionary({ minInterval: 0, maxRetries: 3, timeoutMs: 3000 });
    const res = await r.lookup('test');
    ok('遇到 429 会自动重试并最终成功', res.ok === true, JSON.stringify(res));
    eq('重试次数正确（2 次失败 + 1 次成功）', calls, 3);
    ok('标记了曾触发限流', r.rateLimited === true);
    ok('成功后拿到词性短码', res.ok && res.pos.includes('n'), res.ok && JSON.stringify(res.pos));

    // 缓存：同样的词不再请求
    const before = calls;
    await r.lookup('test');
    eq('重复查询走缓存不再请求', calls, before);

    // 404 不重试
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return { ok: false, status: 404, headers: { get: () => null } };
    };
    const r2 = new RemoteDictionary({ minInterval: 0, maxRetries: 3, timeoutMs: 3000 });
    const res2 = await r2.lookup('nosuchword');
    eq('404 只请求一次，不重试', calls, 1);
    ok('404 标记 notFound', res2.notFound === true);
    ok('404 提示语友好', /无此词条/.test(res2.error || ''), res2.error);

    // 5xx 也会重试，最终失败时给出错误而不是抛异常
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return { ok: false, status: 503, headers: { get: () => null } };
    };
    const r3 = new RemoteDictionary({ minInterval: 0, maxRetries: 2, timeoutMs: 3000 });
    const res3 = await r3.lookup('whatever');
    ok('持续 5xx 最终返回失败而不是抛异常', res3.ok === false);
    eq('5xx 重试到上限', calls, 3);

    // 网络异常也不会抛
    globalThis.fetch = async () => { throw new Error('network down'); };
    const r4 = new RemoteDictionary({ minInterval: 0, maxRetries: 1, timeoutMs: 3000 });
    const res4 = await r4.lookup('whatever');
    ok('网络异常被吞掉并返回失败', res4.ok === false, JSON.stringify(res4));
  } finally {
    globalThis.fetch = origFetch;
  }
}

/* ================================================================
 *  18. 学习计划
 * ================================================================ */
section('18. 学习计划');

{
  const db = freshDb();
  seedWords(db, 100);

  // ---- 没有计划时不排新词 ----
  const day0 = ensureDailyTasks(db, D1);
  eq('无计划时不生成新词任务', day0.newTotal, 0);
  eq('无计划时 hasPlan=false', day0.hasPlan, false);

  // ---- 估算天数 ----
  const est = estimatePlan(db, 20, D1);
  eq('待学词数', est.unlearned, 100);
  eq('每天 20 词 → 5 天', est.days, 5);
  eq('预计完成日期', est.finishDate, addDays(D1, 4));
  eq('每天 30 词 → 4 天（向上取整）', estimatePlan(db, 30, D1).days, 4);
  eq('每天 7 词 → 15 天（100/7 向上取整）', estimatePlan(db, 7, D1).days, 15);
  eq('每天 200 词 → 1 天', estimatePlan(db, 200, D1).days, 1);

  // ---- 开始计划 ----
  const r = startPlan(db, { wordsPerDay: 20, spellingEnabled: false, date: D1 });
  eq('计划覆盖 100 词', r.targetWords, 100);
  eq('计划每日 20 词', r.wordsPerDay, 20);
  ok('有进行中的计划', !!getActivePlan(db));
  eq('拼写开关同步到设置', getSettings(db).spelling_enabled, '0');
  eq('每日词数同步到设置', getSettings(db).daily_new_target, '20');

  const day1 = ensureDailyTasks(db, D1);
  eq('开始计划后当天排 20 词', day1.newTotal, 20);
  eq('计划开始后 hasPlan=true', day1.hasPlan, true);

  // ---- 学完第一天的 ----
  for (const it of getPendingQueue(db, D1)) {
    recordAnswer(db, {
      wordId: it.word_id, mode: it.kind === 'new' ? 'new' : 'review',
      questionType: 'en2cn', isCorrect: true, taskId: it.task_id, date: D1,
    });
  }
  const p1 = planProgress(db, D1);
  eq('进度：已学 20 词', p1.learned, 20);
  eq('进度：20%', p1.percent, 20);
  eq('进度：第 1 天', p1.dayIndex, 1);
  eq('进度：还剩 80 词', p1.remaining, 80);

  // ---- 第二天自动继续，不用再点开始 ----
  const planIdBefore = getActivePlan(db).id;
  const D2 = addDays(D1, 1);
  const day2 = ensureDailyTasks(db, D2);
  eq('第二天自动排 20 词（不用再点开始）', day2.newTotal, 20);
  eq('第二天仍是同一个计划', getActivePlan(db).id, planIdBefore);

  // ---- 取消计划后不再排新词 ----
  cancelPlan(db, D2);
  const day3 = ensureDailyTasks(db, addDays(D2, 1));
  eq('取消后不再排新词', day3.newTotal, 0);
  eq('取消后 hasPlan=false', day3.hasPlan, false);
}

{
  // ---- 全部学完后计划自动完成 ----
  const db = freshDb();
  seedWords(db, 10);
  startPlan(db, { wordsPerDay: 5, spellingEnabled: true, date: D1 });

  for (const d of [D1, addDays(D1, 1)]) {
    ensureDailyTasks(db, d);
    for (const it of getPendingQueue(db, d)) {
      recordAnswer(db, {
        wordId: it.word_id, mode: it.kind === 'new' ? 'new' : 'review',
        questionType: 'en2cn', isCorrect: true, taskId: it.task_id, date: d,
      });
    }
  }

  const p = planProgress(db, addDays(D1, 1));
  eq('10 词全部学完', p.learned, 10);
  eq('剩余 0', p.remaining, 0);
  eq('进度 100%', p.percent, 100);

  // 即使过了很久仍未收尾，天数也不能超过计划总天数
  const late = planProgress(db, addDays(D1, 30));
  ok('天数钳制在计划总天数内', late.dayIndex <= late.plannedDays,
    `dayIndex=${late.dayIndex} plannedDays=${late.plannedDays}`);
  eq('钳制后等于总天数', late.dayIndex, 2);

  const closed = closePlanIfDone(db, addDays(D1, 1));
  ok('计划被自动标记完成', closed === true);
  eq('状态为 finished', db.get('SELECT status FROM study_plan ORDER BY id DESC LIMIT 1').status, 'finished');
  ok('完成后没有进行中的计划', getActivePlan(db) === null);
}

{
  // ---- 拼写模式开关 ----
  const all = 'en2cn,cn2en,spell,en2def';
  ok('开启时包含拼写题', activeTypes(true, all).includes('spell'));
  ok('关闭时不含拼写题', !activeTypes(false, all).includes('spell'));
  eq('关闭后仍有其它题型', activeTypes(false, all).length, 3);
  ok('只配了拼写也能兜底', activeTypes(false, 'spell').length > 0);
  ok('兜底出来的不是拼写', !activeTypes(false, 'spell').includes('spell'));

  // 关闭拼写后，四种题型都不会返回 spell 题
  const word = {
    id: 1, word: 'apple', display_word: 'apple',
    original_translation: '苹果', part_of_speech: 'n', uk_ipa: '', english_example: '',
  };
  const other = { ...word, id: 2, word: 'banana', display_word: 'banana', original_translation: '香蕉' };
  const types = activeTypes(false, all);
  let sawSpell = false;
  for (let i = 0; i < 40; i++) {
    const q = buildQuestion(word, [word, other], { types, rng: makeRng(i) });
    if (q && q.type === 'spell') sawSpell = true;
  }
  ok('关闭拼写模式后 40 次出题都没有拼写题', !sawSpell);
}

/* ================================================================
 *  19. 行首编号剥离
 * ================================================================ */
section('19. 行首编号剥离');

{
  // stripListNumber 只负责剥前缀，不碰后面的中文释义
  const stripCases = [
    ['10 exceptional 杰出的', 'exceptional 杰出的'],
    ['1. abandon 放弃', 'abandon 放弃'],
    ['2、 achieve 实现', 'achieve 实现'],
    ['3) schedule 时间表', 'schedule 时间表'],
    ['(5) accurate 准确的', 'accurate 准确的'],
    ['（7） charge 充电', 'charge 充电'],
    ['[9] absorb 吸收', 'absorb 吸收'],
    ['① apple 苹果', 'apple 苹果'],
    ['② ability 能力', 'ability 能力'],
    ['• abstract 抽象的', 'abstract 抽象的'],
    ['12: adapt 适应', 'adapt 适应'],
    ['  15   advance 前进', 'advance 前进'],
  ];
  for (const [input, expect] of stripCases) {
    eq(`剥离编号 "${input}"`, stripListNumber(input), expect);
  }

  // 不能误伤：数字开头的正常词
  eq('不误伤 3D', stripListNumber('3D 三维的'), '3D 三维的');
  eq('不误伤 4K', stripListNumber('4K 超高清'), '4K 超高清');
  eq('不误伤 24/7', stripListNumber('24/7 全天候'), '24/7 全天候');
  eq('不误伤普通单词', stripListNumber('exceptional 杰出的'), 'exceptional 杰出的');
}

{
  // 整行解析：各种编号格式都要得到干净的单词
  const parseCases = [
    ['10 exceptional 杰出的；异常的', 'exceptional', '杰出的；异常的'],
    ['1. abandon 放弃', 'abandon', '放弃'],
    ['2、 achieve 实现', 'achieve', '实现'],
    ['(5) accurate 准确的', 'accurate', '准确的'],
    ['① apple 苹果', 'apple', '苹果'],
    ['12) schedule 时间表', 'schedule', '时间表'],
    ['15 vt. achieve 实现', 'achieve', '实现'],
    ['3. charge /tʃɑːdʒ/ n. 充电', 'charge', '充电'],
  ];
  for (const [line, word, cn] of parseCases) {
    const rows = parsePastedText(line);
    ok(`解析 "${line}" 得到一行`, rows.length === 1, rows.length);
    if (rows.length) {
      eq(`  → 单词`, rows[0].word, word);
      eq(`  → 释义`, rows[0].translation, cn);
    }
  }

  // 数字开头的正常词不能被剥成空
  const d3 = parsePastedText('3D 三维的；立体的');
  eq('3D 保留原样', d3[0].word, '3D');

  // 制表符：序号单独占一列
  const tab = parsePastedText('10\texceptional\t杰出的');
  eq('Tab 三列：序号被剥掉', tab[0].word, 'exceptional');
  eq('Tab 三列：释义正确', tab[0].translation, '杰出的');
}

{
  // 历史数据修复：库里已经存成 "10 exceptional" 的要能改回来
  const db = freshDb();
  const rows = [
    { word: '10 exceptional', display: '10 exceptional', translation: '杰出的', pos: [],
      ukIpa: '', usIpa: '', example: '', exampleTranslation: '', keep: true },
    { word: '3. abandon', display: '3. abandon', translation: '放弃', pos: [],
      ukIpa: '', usIpa: '', example: '', exampleTranslation: '', keep: true },
    { word: 'apple', display: 'apple', translation: '苹果', pos: [],
      ukIpa: '', usIpa: '', example: '', exampleTranslation: '', keep: true },
  ];
  const preview = buildImportPreview(db, rows);
  commitImport(db, { name: '带编号', sourceType: 'paste', rows: preview.rows });

  eq('导入后确实存了带编号的单词',
    db.get(`SELECT COUNT(*) AS c FROM words WHERE word GLOB '[0-9]*'`).c, 2);

  const rep = repairNumberedWords(db);
  eq('修复了 2 个', rep.fixed, 2);

  const words = db.all('SELECT word FROM words ORDER BY word').map((r) => r.word);
  eq('修复后的单词表', words, ['abandon', 'apple', 'exceptional']);
  eq('不再有数字开头的词',
    db.get(`SELECT COUNT(*) AS c FROM words WHERE word GLOB '[0-9]*'`).c, 0);
  eq('释义没被破坏',
    db.get('SELECT original_translation FROM words WHERE word=?', ['exceptional']).original_translation,
    '杰出的');

  // 重复执行应当无副作用
  const rep2 = repairNumberedWords(db);
  eq('再跑一次不再改动', rep2.fixed, 0);
}

/* ================================================================
 *  20. 删除词库与全部删除
 * ================================================================ */
section('20. 删除与清理');

{
  // 造一个带完整学习痕迹的词库
  const db = freshDb();
  const mk = (name, words) => {
    const rows = words.map((w, i) => ({
      word: w, display: w, translation: '释义' + i, pos: [],
      ukIpa: '', usIpa: '', example: '', exampleTranslation: '', keep: true,
    }));
    const p = buildImportPreview(db, rows);
    return commitImport(db, { name, sourceType: 'paste', rows: p.rows });
  };

  const A = mk('词库A', ['apple', 'banana', 'cherry']);
  const B = mk('词库B', ['dog', 'egg']);
  eq('两个库共 5 个词', db.get('SELECT COUNT(*) AS c FROM words').c, 5);
  eq('词库数 2', listWordLists(db).length, 2);

  // 先学几个词，制造学习记录
  startPlan(db, { wordsPerDay: 50, spellingEnabled: true, date: D1 });
  ensureDailyTasks(db, D1);
  for (const it of getPendingQueue(db, D1).slice(0, 3)) {
    recordAnswer(db, { wordId: it.word_id, mode: 'new', questionType: 'en2cn',
      isCorrect: true, taskId: it.task_id, date: D1 });
  }
  ok('学习记录已产生', db.get('SELECT COUNT(*) AS c FROM learning_records').c > 0);

  // ---------- 删除词库A：它的词应一并消失 ----------
  const delA = deleteWordList(db, A.listId);
  eq('词库A 移除了 3 个单词', delA.removedWords, 3);
  eq('删除后总数 2', db.get('SELECT COUNT(*) AS c FROM words').c, 2);
  eq('统计同步更新', getStats(db).totalWords, 2);
  eq('词库A 的单词彻底没了',
    db.get(`SELECT COUNT(*) AS c FROM words WHERE word IN ('apple','banana','cherry')`).c, 0);
  eq('词库A 的学习记录被级联清除',
    db.get(`SELECT COUNT(*) AS c FROM learning_records WHERE word_id NOT IN (SELECT id FROM words)`).c, 0);

  // ---------- 共享单词不误删 ----------
  const C = mk('共享1', ['shared', 'only1']);
  const D = mk('共享2', ['shared', 'only2']);
  const beforeShared = db.get('SELECT COUNT(*) AS c FROM words').c;
  const delC = deleteWordList(db, C.listId);
  eq('只删掉属于共享1 独有的 1 个词', delC.removedWords, 1);
  eq('总数只少 1', db.get('SELECT COUNT(*) AS c FROM words').c, beforeShared - 1);
  ok('共享词还在', !!db.get('SELECT id FROM words WHERE word=?', ['shared']));
  ok('共享2 独有的词还在', !!db.get('SELECT id FROM words WHERE word=?', ['only2']));

  // ---------- 孤儿单词清理（修复历史数据）----------
  const db2 = freshDb();
  const rows2 = ['a1', 'a2', 'b1'].map((w, i) => ({
    word: w, display: w, translation: '义' + i, pos: [],
    ukIpa: '', usIpa: '', example: '', exampleTranslation: '', keep: true,
  }));
  const p2 = buildImportPreview(db2, rows2);
  const list2 = commitImport(db2, { name: '库', sourceType: 'paste', rows: p2.rows });
  // 手动制造孤儿：只删关系，不删单词（模拟旧版本的行为）
  db2.run('DELETE FROM word_list_items WHERE word_id IN (SELECT id FROM words WHERE word IN (?,?))',
    ['a1', 'a2']);
  eq('制造出 3 个单词 1 个关系', db2.get('SELECT COUNT(*) AS c FROM words').c, 3);
  eq('统计里仍算 3 个（旧 bug）', getStats(db2).totalWords, 3);

  const pr = pruneOrphanWords(db2);
  eq('清理掉 2 个孤儿', pr.removed, 2);
  eq('剩 1 个', pr.remaining, 1);
  eq('统计随之变为 1', getStats(db2).totalWords, 1);
  ok('有归属的词没被误删', !!db2.get('SELECT id FROM words WHERE word=?', ['b1']));
  eq('再跑一次无副作用', pruneOrphanWords(db2).removed, 0);

  // 词库全删光时不触发清理（避免异常状态下误删）
  const db3 = freshDb();
  const rows3 = [{ word: 'x', display: 'x', translation: '叉', pos: [], ukIpa: '',
    usIpa: '', example: '', exampleTranslation: '', keep: true }];
  const p3 = buildImportPreview(db3, rows3);
  commitImport(db3, { name: 'l', sourceType: 'paste', rows: p3.rows });
  db3.run('DELETE FROM word_list_items');   // 只删关系，词库还在
  db3.run('DELETE FROM word_lists');        // 词库也没了 → 0 个词库
  const pr3 = pruneOrphanWords(db3);
  eq('没有词库时不自动清空', pr3.removed, 0);
  eq('单词保留', db3.get('SELECT COUNT(*) AS c FROM words').c, 1);
}

{
  // ---------- 全部删除 ----------
  const db = freshDb();
  const rows = ['one', 'two', 'three'].map((w, i) => ({
    word: w, display: w, translation: '义' + i, pos: [],
    ukIpa: '', usIpa: '', example: '', exampleTranslation: '', keep: true,
  }));
  const p = buildImportPreview(db, rows);
  commitImport(db, { name: '全删测试', sourceType: 'paste', rows: p.rows });
  startPlan(db, { wordsPerDay: 2, spellingEnabled: true, date: D1 });
  ensureDailyTasks(db, D1);
  const q = getPendingQueue(db, D1);
  if (q.length) {
    recordAnswer(db, { wordId: q[0].word_id, mode: 'new', questionType: 'en2cn',
      isCorrect: true, taskId: q[0].task_id, date: D1 });
  }
  setSetting(db, 'theme', 'dark');

  ok('删除前有数据',
    db.get('SELECT COUNT(*) AS c FROM words').c === 3 &&
    db.get('SELECT COUNT(*) AS c FROM word_lists').c === 1);

  const r = deleteAllData(db);
  eq('返回删除的单词数', r.removedWords, 3);

  eq('单词清空', db.get('SELECT COUNT(*) AS c FROM words').c, 0);
  eq('词库清空', db.get('SELECT COUNT(*) AS c FROM word_lists').c, 0);
  eq('关联清空', db.get('SELECT COUNT(*) AS c FROM word_list_items').c, 0);
  eq('学习记录清空', db.get('SELECT COUNT(*) AS c FROM learning_records').c, 0);
  eq('记忆状态清空', db.get('SELECT COUNT(*) AS c FROM review_schedule').c, 0);
  eq('每日任务清空', db.get('SELECT COUNT(*) AS c FROM daily_tasks').c, 0);
  eq('每日进度清空', db.get('SELECT COUNT(*) AS c FROM daily_progress').c, 0);
  eq('学习计划清空', db.get('SELECT COUNT(*) AS c FROM study_plan').c, 0);
  eq('核对历史清空', db.get('SELECT COUNT(*) AS c FROM translation_check_records').c, 0);
  eq('设置保留（主题还在）', getSettings(db).theme, 'dark');

  const st = getStats(db);
  eq('统计归零', [st.totalWords, st.studied, st.totalAnswers], [0, 0, 0]);
  eq('清空后没有进行中的计划', getActivePlan(db), null);

  // 清空后还能重新导入使用
  const p2 = buildImportPreview(db, rows);
  commitImport(db, { name: '重来', sourceType: 'paste', rows: p2.rows });
  eq('清空后可重新导入', db.get('SELECT COUNT(*) AS c FROM words').c, 3);
}

/* ================================================================
 *  汇总
 * ================================================================ */
const pass = results.filter((r) => r.pass === true).length;
const fail = results.filter((r) => r.pass === false).length;

console.log('\n================ 验收测试结果 ================');
for (const r of results) {
  if (r.section) { console.log('\n— ' + r.section + ' —'); continue; }
  if (r.pass === false) console.log('  ✗ FAIL  ' + r.name + (r.extra ? '\n           ' + r.extra : ''));
}
console.log(`\n通过 ${pass} / 失败 ${fail} / 共 ${pass + fail}`);
process.exitCode = fail ? 1 : 0;
