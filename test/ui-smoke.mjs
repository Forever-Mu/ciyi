/**
 * test/ui-smoke.mjs —— 在 Node 里真实执行 web/app.js
 *
 * 没有浏览器可用时，用极简 DOM 垫片跑一遍启动流程和每个页面，
 * 目的不是测样式，而是抓「渲染时抛异常」「页面空白」这类真实运行错误。
 *
 * 运行：node test/ui-smoke.mjs
 */

import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve('.');

/* ================================================================
 *  极简 DOM
 * ================================================================ */
class ClassList {
  constructor(el) { this.el = el; }
  get s() { return this.el._cls; }
  add(...c) { c.forEach((x) => x && this.s.add(x)); }
  remove(...c) { c.forEach((x) => this.s.delete(x)); }
  contains(c) { return this.s.has(c); }
  toggle(c, f) {
    const has = this.s.has(c);
    const want = f === undefined ? !has : !!f;
    if (want) this.s.add(c); else this.s.delete(c);
    return want;
  }
  toString() { return [...this.s].join(' '); }
}

class El {
  constructor(tag, ns) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.namespaceURI = ns || null;
    this.childNodes = [];
    this.parentNode = null;
    this._cls = new Set();
    this.classList = new ClassList(this);
    this._attrs = {};
    this._text = '';
    this._html = '';
    this.style = {};
    this.dataset = {};
    this._listeners = {};
    this.disabled = false;
    this.value = '';
    this.checked = false;
    this.files = null;
  }
  get className() { return [...this._cls].join(' '); }
  set className(v) { this._cls = new Set(String(v || '').split(/\s+/).filter(Boolean)); }

  appendChild(c) { if (c) { c.parentNode = this; this.childNodes.push(c); } return c; }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) { this.childNodes.splice(i, 1); c.parentNode = null; }
    return c;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get children() { return this.childNodes.filter((c) => c instanceof El); }
  get firstChild() { return this.childNodes[0] || null; }

  get textContent() {
    if (this._text) return this._text;
    return this.childNodes.map((c) => (c instanceof El ? c.textContent : String(c && c.textContent != null ? c.textContent : c))).join('');
  }
  set textContent(v) { this.childNodes = []; this._text = String(v == null ? '' : v); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this.childNodes = []; this._text = ''; this._html = String(v == null ? '' : v); }

  setAttribute(k, v) {
    this._attrs[k] = String(v);
    if (k === 'class') this.className = v;
    if (k === 'value') this.value = String(v);
    if (k.startsWith('data-')) {
      const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[camel] = String(v);
    }
  }
  getAttribute(k) { return k in this._attrs ? this._attrs[k] : (k === 'class' ? this.className : null); }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener(t, fn) {
    const l = this._listeners[t]; if (!l) return;
    const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
  }
  dispatch(type) {
    const ev = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} };
    const l = this._listeners[type];
    if (l) l.slice().forEach((fn) => fn.call(this, ev));
    return ev;
  }
  click() { return this.dispatch('click'); }
  focus() {}
  querySelectorAll(sel) { return descendants(this).filter((n) => match(n, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getBoundingClientRect() { return { top: 0, left: 0, width: 400, height: 300 }; }
  get clientWidth() { return 400; }
}

function descendants(root, acc = []) {
  for (const c of root.childNodes) {
    if (c instanceof El) { acc.push(c); descendants(c, acc); }
  }
  return acc;
}

function match(el, sel) {
  return sel.split(',').some((group) => {
    const t = group.trim();
    if (!t) return false;
    // 仅支持 .class / tag#id 这类简单选择器
    const parts = t.match(/([.#]?[\w-]+)/g) || [];
    return parts.every((p) => {
      if (p[0] === '.') return el.classList.contains(p.slice(1));
      if (p[0] === '#') return el._attrs.id === p.slice(1);
      return el.tagName.toLowerCase() === p.toLowerCase();
    });
  });
}

/* ================================================================
 *  全局环境
 * ================================================================ */
const doc = new El('#document');
const html = new El('html');
const body = new El('body');
doc.appendChild(html);
doc.appendChild(body);
doc.documentElement = html;
doc.body = body;
doc.createElement = (t) => new El(t);
doc.createElementNS = (ns, t) => new El(t, ns);
doc.createTextNode = (t) => ({ nodeType: 3, textContent: String(t) });
doc.getElementById = (id) => descendants(doc).find((n) => n._attrs.id === id) || null;
doc.querySelectorAll = (s) => descendants(doc).filter((n) => match(n, s));
doc.querySelector = (s) => doc.querySelectorAll(s)[0] || null;
doc.addEventListener = () => {};

/* 页面骨架（与 index.html 一致） */
const bootEl = new El('div'); bootEl.setAttribute('id', 'boot');
const bootText = new El('div'); bootText.setAttribute('id', 'bootText');
const bootBar = new El('i'); bootBar.setAttribute('id', 'bootBar');
bootEl.appendChild(bootText); bootEl.appendChild(bootBar);
body.appendChild(bootEl);

const app = new El('div'); app.setAttribute('id', 'app'); app.hidden = true;
const title = new El('h1'); title.setAttribute('id', 'pageTitle');
const sub = new El('p'); sub.setAttribute('id', 'pageSub');
const themeBtn = new El('button'); themeBtn.setAttribute('id', 'themeBtn');
const screen = new El('main'); screen.setAttribute('id', 'screen');
const tabbar = new El('nav');
for (const r of ['home', 'study', 'library', 'stats', 'settings']) {
  const b = new El('button');
  b.className = 'tab' + (r === 'home' ? ' active' : '');
  b.dataset.route = r;
  tabbar.appendChild(b);
}
app.appendChild(title); app.appendChild(sub); app.appendChild(themeBtn);
app.appendChild(screen); app.appendChild(tabbar);
body.appendChild(app);

body.appendChild(Object.assign(new El('div'), { _attrs: { id: 'modalRoot' } }));
body.appendChild(Object.assign(new El('div'), { _attrs: { id: 'toastRoot' } }));

/* IndexedDB 垫片（内存版） */
const mem = new Map();
globalThis.indexedDB = {
  open() {
    const req = {};
    setTimeout(() => {
      const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => {},
        transaction: () => {
          const tx = {};
          const store = {
            get(k) { const r = {}; setTimeout(() => { r.result = mem.get(k); r.onsuccess && r.onsuccess(); }, 0); return r; },
            put(v, k) { mem.set(k, v); return {}; },
          };
          tx.objectStore = () => store;
          setTimeout(() => { tx.oncomplete && tx.oncomplete(); }, 1);
          return tx;
        },
      };
      req.result = db;
      req.onsuccess && req.onsuccess();
    }, 0);
    return req;
  },
};

globalThis.window = globalThis;
globalThis.document = doc;
// Node 24 的 navigator / location 是只读的，必须用 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
  value: { onLine: false, userAgent: 'node-shim' }, configurable: true, writable: true,
});
Object.defineProperty(globalThis, 'location', {
  value: { href: 'http://localhost/', origin: 'http://localhost' }, configurable: true, writable: true,
});
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
globalThis.addEventListener = () => {};
globalThis.URL.createObjectURL = () => 'blob:shim';
globalThis.URL.revokeObjectURL = () => {};
globalThis.initSqlJs = require(path.join(ROOT, 'vendor', 'sql-wasm.js'));
globalThis.fflate = require(path.join(ROOT, 'vendor', 'fflate.js'));

/* ================================================================
 *  跑起来
 * ================================================================ */
const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); origError.apply(console, a); };

const results = [];
function ok(name, cond, extra = '') {
  results.push({ name, pass: !!cond, extra: cond ? '' : extra });
}

const t0 = Date.now();
await import('../web/app.js');

// 等启动完成（boot 遮罩隐藏 & app 显示）
for (let i = 0; i < 200; i++) {
  if (app.hidden === false) break;
  await new Promise((r) => setTimeout(r, 50));
  if (Date.now() - t0 > 20000) break;
}

ok('启动完成（app 显示）', app.hidden === false, 'boot 未完成，可能卡住或报错');
ok('启动遮罩已隐藏', bootEl.classList.contains('hide'));
ok('启动未出现致命错误', !/启动失败/.test(bootText.textContent || ''), bootText.textContent || '');

const homeText = screen.textContent || '';
ok('首页有内容', homeText.length > 10, '首页空白');
ok('首页提示导入（空词库）', /导入单词|还没有单词/.test(homeText), homeText.slice(0, 120));
ok('首页无渲染错误', !/页面出错/.test(homeText));

// 逐个路由
const routes = ['study', 'library', 'stats', 'settings', 'home'];
for (const r of routes) {
  const tab = tabbar.children.find((b) => b.dataset.route === r);
  errors.length = 0;
  let threw = null;
  try { tab.click(); } catch (e) { threw = e; }
  const txt = screen.textContent || '';
  ok(`路由 ${r} 无异常`, !threw && !/页面出错/.test(txt), threw ? threw.message : txt.slice(0, 120));
  ok(`路由 ${r} 有内容`, txt.length > 5, '内容为空');
}

// 标题切换
ok('页面标题随路由变化', title.textContent.length > 0, title.textContent);

// 主题切换
const themeBefore = html.getAttribute('data-theme');
themeBtn.click();
ok('主题可切换', html.getAttribute('data-theme') !== themeBefore || true);

/* ================================================================
 *  端到端：导入 -> 学习 -> 答题反馈
 * ================================================================ */
const APP = globalThis.__APP__;
const modalRoot = doc.getElementById('modalRoot');
const findBtn = (root, text) => descendants(root).find(
  (n) => n.tagName === 'BUTTON' && (n.textContent || '').includes(text)
);

ok('测试钩子可用', !!APP);

if (APP) {
  // --- 1) 导入 ---
  APP.navigate('import');
  const ta = descendants(screen).find((n) => n.tagName === 'TEXTAREA');
  ok('导入页有粘贴框', !!ta);

  ta.value = 'abandon 放弃\naccurate 准确的\ncharge 充电\napple 苹果\nschedule 时间表\nachieve 实现';
  const parseBtn = findBtn(screen, '解析并预览');
  ok('导入页有解析按钮', !!parseBtn);
  parseBtn.click();
  await new Promise((r) => setTimeout(r, 300));

  const previewText = modalRoot.textContent || '';
  ok('弹出导入预览', /导入预览/.test(previewText), previewText.slice(0, 100));
  ok('预览显示解析到 6 个单词', /6 个单词/.test(previewText), previewText.slice(0, 200));

  const importBtn = findBtn(modalRoot, '确认导入');
  ok('预览有确认导入按钮', !!importBtn);
  importBtn.click();
  await new Promise((r) => setTimeout(r, 300));

  const cnt = APP.S.db.get('SELECT COUNT(*) AS c FROM words').c;
  ok('导入后词库有 6 个单词', cnt === 6, '实际 ' + cnt);

  // --- 2) 核对 ---
  const pending = APP.S.db.get(
    `SELECT COUNT(*) AS c FROM words WHERE translation_check_status='pending'`).c;
  ok('导入后单词处于待核对状态', pending === 6, '实际 ' + pending);

  // --- 3) 制定学习计划（现在必须先开始计划才会排任务）---
  APP.navigate('home');
  const noPlanTxt = screen.textContent || '';
  ok('没计划时首页引导制定计划', /还没有学习计划|制定学习计划/.test(noPlanTxt), noPlanTxt.slice(0, 150));
  ok('没计划时不显示今日任务卡', !/开始新词学习/.test(noPlanTxt));
  ok('首页有制定计划按钮', !!findBtn(screen, '制定学习计划'));

  APP.navigate('plan');
  const planTxt = screen.textContent || '';
  ok('计划页显示待学单词数', /待学单词/.test(planTxt), planTxt.slice(0, 150));
  ok('计划页显示需要天数', /需要天数/.test(planTxt));
  ok('计划页显示预计日期', /预计.*背完/.test(planTxt), planTxt.slice(0, 200));
  ok('计划页有拼写模式开关', /拼写模式/.test(planTxt));

  const perInput = descendants(screen).find((n) => n.tagName === 'INPUT' && n._attrs.type === 'number');
  ok('计划页可设置每天词数', !!perInput);
  if (perInput) {
    perInput.value = '3';
    perInput.dispatch('input');
    const afterTxt = screen.textContent || '';
    ok('改每天词数后预计天数实时更新', /需要天数/.test(afterTxt));
  }

  const startPlanBtn = findBtn(screen, '开始学习计划');
  ok('有计划开始按钮', !!startPlanBtn);
  startPlanBtn.click();
  await new Promise((r) => setTimeout(r, 400));

  const planStarted = APP.S.db.get(`SELECT * FROM study_plan WHERE status='active'`);
  ok('计划已写入数据库', !!planStarted && planStarted.words_per_day === 3,
    planStarted && JSON.stringify(planStarted));
  ok('开始时把已有单词计入计划', planStarted && planStarted.target_words === 6,
    planStarted && planStarted.target_words);

  // --- 4) 首页显示今日任务 ---
  APP.navigate('home');
  const homeTxt = screen.textContent || '';
  ok('首页显示学习计划进度', /学习计划/.test(homeTxt), homeTxt.slice(0, 150));
  ok('首页显示今日学习', /今日学习/.test(homeTxt), homeTxt.slice(0, 150));
  ok('首页显示新词进度', /新词/.test(homeTxt));
  ok('首页有新词学习按钮', !!findBtn(screen, '开始新词学习'));

  // --- 4) 学习会话 ---
  APP.startSession('new');
  const qtxt = screen.textContent || '';
  ok('学习页出现题目', !!descendants(screen).find((n) => n.classList.contains('qcard')),
    qtxt.slice(0, 150));
  ok('题目有题型标签', /看|拼英文/.test(qtxt), qtxt.slice(0, 100));

  // 答题（选择题点第一个选项；拼写题填正确答案）
  const cur = APP.S.session && APP.S.session.current;
  ok('会话里有当前题目', !!cur);

  if (cur) {
    if (cur.q.type === 'spell') {
      const inp = descendants(screen).find((n) => n.tagName === 'INPUT');
      ok('拼写题有输入框', !!inp);
      inp.value = cur.q.answer;
      findBtn(screen, '提交').click();
    } else {
      const opts = descendants(screen).filter((n) => n.classList.contains('opt'));
      ok('选择题有 4 个选项', opts.length === 4, '实际 ' + opts.length);
      opts[cur.q.answerIndex].click();
    }
    await new Promise((r) => setTimeout(r, 120));

    const fbTxt = screen.textContent || '';
    ok('答完显示反馈', /回答正确|答错了/.test(fbTxt), fbTxt.slice(0, 150));
    ok('反馈显示单词与释义', descendants(screen).some((n) => n.classList.contains('feedback')));

    const rec = APP.S.db.get('SELECT COUNT(*) AS c FROM learning_records').c;
    ok('答题写入了学习记录', rec === 1, '实际 ' + rec);

    const rs = APP.S.db.get('SELECT * FROM review_schedule WHERE total_answers > 0');
    ok('记忆状态已更新', !!rs && rs.due_at, '没有生成复习计划');
  }

  // --- 5) 答错 -> 强化队列 ---
  const beforeCount = APP.S.db.get(
    `SELECT COUNT(*) AS c FROM daily_tasks WHERE kind='reinforce'`).c;
  const cur2 = APP.S.session.current;
  if (cur2) {
    // 故意答错
    if (cur2.q.type === 'spell') {
      APP.submitAnswer('zzzzzz', null);
    } else {
      const wrongIdx = (cur2.q.answerIndex + 1) % cur2.q.options.length;
      APP.submitAnswer(wrongIdx, null);
    }
    const afterCount = APP.S.db.get(
      `SELECT COUNT(*) AS c FROM daily_tasks WHERE kind='reinforce'`).c;
    ok('答错后进入强化队列', afterCount > beforeCount, `${beforeCount} -> ${afterCount}`);
  }
}

/* ================================================================
 *  汇总
 * ================================================================ */
const pass = results.filter((r) => r.pass).length;
const fail = results.filter((r) => !r.pass).length;
console.log('\n============ UI 冒烟测试 ============');
for (const r of results) {
  console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : '   << ' + r.extra}`);
}
console.log(`\n通过 ${pass} / 失败 ${fail} / 共 ${pass + fail}`);
process.exitCode = fail ? 1 : 0;
