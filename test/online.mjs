/**
 * test/online.mjs —— 在线词典真实网络验收
 *
 * 与 run.mjs 分开：run.mjs 必须离线可复现，这里专门打真实 API。
 * 网络不可用时整体跳过（退出码 0），不会让 CI 假红。
 *
 * 运行：node test/online.mjs
 */

import path from 'node:path';
import { createRequire } from 'node:module';

import { loadSqlJsNode, createDB } from '../core/db.js';
import { setFflate } from '../core/platform.js';
import { LocalDictionary, DictionaryService, RemoteDictionary, loadSynonymMap } from '../core/dictionary.js';
import { parsePastedText } from '../core/parse.js';
import { buildImportPreview, commitImport, checkWords } from '../core/service.js';

const require = createRequire(import.meta.url);
setFflate(require(path.resolve('vendor', 'fflate.js')));

const results = [];
function ok(name, cond, extra = '') {
  results.push({ name, pass: !!cond, extra: cond ? '' : extra });
}

const remote = new RemoteDictionary({ timeoutMs: 15000 });

// ---------- 先探网络 ----------
const probe = await remote.lookup('apple');
if (!probe.ok) {
  console.log('\n  在线词典不可用，跳过在线验收：' + (probe.error || '未知错误'));
  console.log('  通过 0 / 失败 0 / 共 0（已跳过）\n');
  process.exit(0);
}
console.log('\n  在线词典连通，开始真实网络验收\n');

// ---------- 1. 基本查询 ----------
{
  const r = await remote.lookup('abandon');
  ok('abandon 查询成功', r.ok);
  ok('abandon 有音标', !!r.mainPhonetic || !!r.ukIpa || !!r.usIpa, JSON.stringify(r.ukIpa));
  ok('abandon 有英文释义', r.definitions.length > 0, r.definitions.length);
  ok('abandon 有例句', r.examples.length > 0, r.examples.length);
  const allDefs = r.definitions.map((d) => d.text).join(' ').toLowerCase();
  ok('abandon 释义里含 give up / surrender 语义',
    /give up|surrender|relinquis|forsak/.test(allDefs), allDefs.slice(0, 120));
}

// ---------- 2. 词性必须归一化成短码 ----------
{
  const cases = [['abandon', 'v'], ['accurate', 'adj'], ['schedule', 'n']];
  for (const [w, expect] of cases) {
    const r = await remote.lookup(w);
    ok(`${w} 词性归一化为短码`, r.ok && r.pos.includes(expect),
      '得到 ' + JSON.stringify(r.pos));
    ok(`${w} 词性里没有英文全称`, r.ok && !r.pos.some((p) => /^(verb|noun|adjective|adverb)$/.test(p)),
      JSON.stringify(r.pos));
  }
}

// ---------- 3. 查不到的词 ----------
{
  const r = await remote.lookup('xyzzyxxxnotaword');
  ok('不存在的词返回失败', !r.ok);
  ok('不存在的词标记 notFound', r.notFound === true, JSON.stringify(r));
}

// ---------- 4. 缓存生效（第二次不应更慢） ----------
{
  const t0 = Date.now();
  await remote.lookup('apple');
  const first = Date.now() - t0;
  const t1 = Date.now();
  await remote.lookup('apple');
  const second = Date.now() - t1;
  ok(`重复查询走缓存（${first}ms -> ${second}ms）`, second <= Math.max(first, 20));
}

// ---------- 5. 端到端：在线补充真的写进了数据库 ----------
{
  const SQL = await loadSqlJsNode('./vendor');
  const dict = await LocalDictionary.load('data/dict.json.gz');
  await loadSynonymMap('data/syn.json.gz');
  const svc = new DictionaryService({ local: dict, remote });

  const db = createDB(SQL);
  db.migrate();

  const rows = parsePastedText('abandon 放弃\naccurate 准确的\nschedule 时间表');
  const preview = buildImportPreview(db, rows);
  commitImport(db, { name: '在线测试', sourceType: 'paste', rows: preview.rows });

  const before = db.all('SELECT * FROM words ORDER BY id');
  ok('导入 3 个词且都没音标', before.length === 3 && before.every((w) => !w.uk_ipa));

  const ids = before.map((w) => w.id);
  const res = await checkWords(db, ids, svc, { allowOnline: true });
  ok('核对完成', res.report.total === 3, JSON.stringify(res.report));
  ok('在线查询无报错', res.report.onlineErrors === 0, res.report.onlineErrors);

  const after = db.all('SELECT * FROM words ORDER BY id');
  ok('在线补充了音标', after.filter((w) => w.uk_ipa).length >= 2,
    after.map((w) => w.word + ':' + w.uk_ipa).join(' '));
  ok('在线补充了例句', after.filter((w) => w.english_example).length >= 1,
    after.map((w) => w.word + ':' + (w.english_example ? 'Y' : 'N')).join(' '));
  ok('词典原始数据被缓存', after.filter((w) => w.dictionary_data).length >= 2);
  ok('在线词性没有污染 part_of_speech',
    after.every((w) => !/verb|noun|adjective/i.test(w.part_of_speech || '')),
    after.map((w) => w.word + ':' + w.part_of_speech).join(' '));
}

// ---------- 汇总 ----------
const pass = results.filter((r) => r.pass).length;
const fail = results.filter((r) => !r.pass).length;
console.log('\n============ 在线词典验收 ============');
for (const r of results) {
  console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : '   << ' + r.extra}`);
}
console.log(`\n通过 ${pass} / 失败 ${fail} / 共 ${pass + fail}\n`);
process.exitCode = fail ? 1 : 0;
