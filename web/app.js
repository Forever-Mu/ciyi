/**
 * web/app.js —— 词忆 App 主程序
 *
 * 单一入口：启动加载 → 路由 → 各页面。
 * 业务逻辑全部在 core/ 里（Node 测试覆盖），这里只负责界面与交互。
 */

import { createDB } from '../core/db.js';
import { today, addDays, diffDays } from '../core/time.js';
import { LocalDictionary, DictionaryService, RemoteDictionary, loadSynonymMap } from '../core/dictionary.js';
import { parsePastedText, parseDocxBuffer, detectColumnRoles, rowsFromTable } from '../core/parse.js';
import {
  buildImportPreview, commitImport, checkWords, applyCheckDecision,
  recordAnswer, getHomeData, searchWords, getStats, listWordLists,
  deleteWordList, deleteWord, updateWord, repairNumberedWords,
  pruneOrphanWords, deleteAllData,
} from '../core/service.js';
import {
  ensureDailyTasks, getPendingQueue, summarizeDay, getSettings, setSetting,
  getActivePlan, planProgress, estimatePlan, startPlan, cancelPlan,
  closePlanIfDone, countUnlearnedWords,
} from '../core/scheduler.js';
import { buildQuestion, gradeAnswer, makeRng, QTYPE, levenshtein, activeTypes } from '../core/quiz.js';
import { STATE_LABEL } from '../core/srs.js';
import { normalizeWord } from '../core/text.js';

/* ================================================================
 *  全局状态
 * ================================================================ */
const S = {
  db: null,
  dict: null,
  dictService: null,
  remote: null,
  route: 'home',
  date: today(),
  settings: {},
  session: null,        // { kind, queueIds:[], current:{q,item}, answered, stats }
  checkResult: null,
  importRows: null,
  libraryFilter: { q: '', state: 'all', offset: 0 },
  lastCard: null,
};

/** 启动时清理掉的孤儿单词数量，用于给用户一个提示 */
let orphanNotice = 0;

const ROUTES = {
  home: { title: '今日', sub: () => S.date },
  study: { title: '学习', sub: () => '新词与复习' },
  library: { title: '词库', sub: () => '' },
  stats: { title: '统计', sub: () => '真实数据，实时计算' },
  settings: { title: '设置', sub: () => 'v1.1.2' },
  plan: { title: '学习计划', sub: () => '定好节奏，之后每天自动安排' },
  check: { title: '翻译核对报告', sub: () => '' },
  import: { title: '导入单词', sub: () => '' },
};

/* ================================================================
 *  DOM 助手
 * ================================================================ */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

const ICON = {
  back: 'M15 18l-6-6 6-6',
  plus: 'M12 5v14M5 12h14',
  check: 'M20 6 9 17l-5-5',
  close: 'M18 6 6 18M6 6l12 12',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 16v-4M12 8h.01',
  book: 'M12 6.5C10.5 5 8 4 4.5 4v13C8 17 10.5 18 12 19.5 13.5 18 16 17 19.5 17V4C16 4 13.5 5 12 6.5ZM12 6.5v13',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 8l5-5 5 5M12 3v12',
  refresh: 'M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
  play: 'M8 5v14l11-7z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3',
};
function icon(name, size = 20) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', '1.8');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('width', size);
  el.setAttribute('height', size);
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICON[name] || ICON.info);
  el.appendChild(p);
  return el;
}

/* ================================================================
 *  Toast / Sheet / Confirm
 * ================================================================ */
function toast(msg, type = 'info', ms = 2200) {
  const root = document.getElementById('toastRoot');
  const el = h('div', { class: 'toast' }, msg);
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  }, ms);
  while (root.children.length > 3) root.firstChild.remove();
}

function sheet({ title, body, footer, onClose }) {
  const root = document.getElementById('modalRoot');
  const scrim = h('div', { class: 'scrim' });
  const box = h('div', { class: 'sheet' });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    scrim.remove();
    if (onClose) onClose();
  };
  box.appendChild(h('div', { class: 'sheet-head' },
    h('h3', { text: title }),
    h('button', { class: 'icon-btn', onclick: close }, icon('close'))
  ));
  const bodyEl = h('div', { class: 'sheet-body' });
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);
  box.appendChild(bodyEl);
  if (footer && footer.length) {
    const f = h('div', { class: 'sheet-foot' });
    footer.forEach((x) => f.appendChild(x));
    box.appendChild(f);
  }
  scrim.appendChild(box);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  root.appendChild(scrim);
  return { close, body: bodyEl };
}

function confirmDialog({ title, message, detail, confirmText = '确定', cancelText = '取消', danger, requireText }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    const body = h('div', { class: 'stack' });
    body.appendChild(h('p', { text: message, style: 'font-size:15px' }));
    if (detail) {
      body.appendChild(h('div', { class: 'notice ' + (danger ? 'bad' : 'warn') },
        icon('alert', 16), h('div', { text: detail })));
    }

    let input = null;
    if (requireText) {
      input = h('input', { class: 'input', type: 'text', placeholder: '请输入「' + requireText + '」' });
      body.appendChild(h('div', { class: 'field' },
        h('label', { text: '输入「' + requireText + '」以确认' }), input));
    }

    const okBtn = h('button', {
      class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'),
      text: confirmText,
      disabled: !!requireText,
      onclick: () => { done(true); m.close(); },
    });
    if (input) {
      input.addEventListener('input', () => { okBtn.disabled = input.value.trim() !== requireText; });
    }

    const m = sheet({
      title,
      body,
      footer: [
        h('button', { class: 'btn btn-outline', text: cancelText, onclick: () => { done(false); m.close(); } }),
        okBtn,
      ],
      onClose: () => done(false),
    });
  });
}

/* ================================================================
 *  持久化（IndexedDB）
 * ================================================================ */
const IDB_NAME = 'enword-memory';
const IDB_STORE = 'kv';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

async function idbPut(key, val) {
  const db = await idbOpen();
  return new Promise((resolve) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(val, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (!S.db) return;
    try {
      await idbPut('db', S.db.toBinary());
    } catch (e) {
      console.error('保存失败', e);
      toast('本地保存失败：' + e.message, 'bad');
    }
  }, 350);
}

/* ================================================================
 *  主题
 * ================================================================ */
function applyTheme() {
  const mode = S.settings.theme || 'auto';
  let resolved = mode;
  if (mode === 'auto') {
    resolved = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', resolved === 'dark' ? 'dark' : 'light');
}
function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const cur = S.settings.theme || 'auto';
  const next = order[(order.indexOf(cur) + 1) % order.length];
  setSetting(S.db, 'theme', next);
  S.settings.theme = next;
  applyTheme();
  toast(next === 'auto' ? '跟随系统' : next === 'light' ? '浅色模式' : '深色模式', 'ok', 1200);
}

/* ================================================================
 *  路由
 * ================================================================ */
/**
 * 路由跳转
 * @param {string} route
 * @param {boolean} [fromHash] 由 hashchange 触发时不要回写 hash，避免死循环
 */
function navigate(route, fromHash) {
  if (!ROUTES[route]) route = 'home';
  S.route = route;

  if (!fromHash) {
    try {
      history.replaceState(null, '', '#' + route);
    } catch (e) {
      /* file:// 或受限环境忽略 */
    }
  }

  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.route === route);
  });
  render();
  const sc = document.getElementById('screen');
  if (sc) sc.scrollTop = 0;
}

function routeFromHash() {
  const r = String((typeof location !== 'undefined' && location.hash) || '').replace(/^#/, '');
  return ROUTES[r] ? r : 'home';
}

function render() {
  const screen = document.getElementById('screen');
  const cfg = ROUTES[S.route] || ROUTES.home;
  document.getElementById('pageTitle').textContent = cfg.title;
  document.getElementById('pageSub').textContent = typeof cfg.sub === 'function' ? cfg.sub() : cfg.sub;
  screen.innerHTML = '';

  const fn = {
    home: screenHome,
    study: screenStudy,
    library: screenLibrary,
    stats: screenStats,
    settings: screenSettings,
    plan: screenPlan,
    check: screenCheckReport,
    import: screenImport,
  }[S.route];

  try {
    const node = fn ? fn() : screenHome();
    if (node) screen.appendChild(node);
  } catch (e) {
    console.error(e);
    screen.appendChild(h('div', { class: 'empty' },
      icon('alert'), h('div', { class: 't', text: '页面出错' }),
      h('div', { class: 's', text: String(e.message || e) })));
  }
}

/* ================================================================
 *  首页
 * ================================================================ */
function screenHome() {
  const home = getHomeData(S.db, S.date);
  const d = home.day;
  const st = getStats(S.db);

  if (home.totalWords === 0) {
    return h('div', { class: 'stack' },
      h('div', { class: 'empty' },
        icon('book'),
        h('div', { class: 't', text: '还没有单词' }),
        h('div', { class: 's', text: '先导入你的 Word 单词表，或直接粘贴' })),
      h('button', { class: 'btn btn-primary btn-block', onclick: () => navigate('import') },
        icon('plus'), '导入单词')
    );
  }

  const newProgress = d.newTotal ? Math.round((d.newDone / d.newTotal) * 100) : 0;
  const reviewProgress = d.reviewTotal ? Math.round((d.reviewDone / d.reviewTotal) * 100) : 0;
  const allDone = d.newLeft === 0 && d.reviewLeft === 0;

  // ---- 没有进行中的计划：不排新词任务，引导用户先制定计划 ----
  const activePlan = getActivePlan(S.db);
  if (!activePlan) {
    const unlearned = countUnlearnedWords(S.db);
    return h('div', { class: 'stack' },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', { text: '还没有学习计划' })),
        h('div', { class: 'card-body stack' },
          h('div', { style: 'font-size:15px;color:var(--text-2)', text:
            unlearned > 0
              ? `还有 ${unlearned} 个单词没学。制定一个计划，之后每天自动安排任务，不用每天再点一次。`
              : '所有单词都已经学过了。想要重新安排或导入新词，可以再开始一个计划。' }),
          unlearned > 0
            ? h('button', { class: 'btn btn-primary btn-block', onclick: () => navigate('plan') },
                icon('play'), '制定学习计划')
            : null,
          d.reviewLeft > 0
            ? h('button', { class: 'btn btn-block', onclick: () => startSession('review') },
                icon('refresh'), `先复习到期的旧词（${d.reviewLeft}）`)
            : null)),
      h('div', { class: 'stat-grid three' },
        h('div', { class: 'stat' }, h('div', { class: 'k', text: '词库总量' }), h('div', { class: 'v', text: String(st.totalWords) })),
        h('div', { class: 'stat info' }, h('div', { class: 'k', text: '已学' }), h('div', { class: 'v', text: String(st.studied) })),
        h('div', { class: 'stat ok' }, h('div', { class: 'k', text: '已掌握' }), h('div', { class: 'v', text: String(st.mastered) }))),
      h('button', { class: 'btn btn-outline btn-block', onclick: () => navigate('import') },
        icon('upload'), '导入更多单词')
    );
  }

  const plan = planProgress(S.db);
  const planCard = plan
    ? h('div', { class: 'card' },
        h('div', { class: 'card-head' },
          h('h3', { text: '学习计划' }),
          h('span', { class: 'hint', text: `第 ${plan.dayIndex} 天 / 共 ${plan.plannedDays} 天` })),
        h('div', { class: 'card-body stack' },
          h('div', { class: 'row', style: 'margin-bottom:6px' },
            h('span', { class: 'tiny muted', text: '总进度' }),
            h('span', { class: 'spacer' }),
            h('span', { class: 'tiny muted', text: `${plan.learned} / ${plan.target} 词` })),
          h('div', { class: 'progress ok' }, h('i', { style: `width:${plan.percent}%` })),
          h('div', { class: 'row-wrap', style: 'gap:8px;margin-top:2px' },
            h('span', { class: 'badge info', text: `每天 ${plan.plan.words_per_day} 词` }),
            h('span', { class: 'badge ' + (plan.spellingEnabled ? 'ok' : 'mute'),
              text: plan.spellingEnabled ? '拼写模式已开' : '拼写模式已关' }),
            h('span', { class: 'badge', text: `预计 ${plan.finishDate} 完成` }),
            h('button', {
              class: 'btn btn-sm btn-ghost',
              onclick: () => navigate('plan'),
            }, '调整'))))
    : null;

  const card = h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h3', { text: '今日学习' }),
      h('span', { class: 'hint', text: d.newTarget + ' 词/天' })),
    h('div', { class: 'card-body stack' },
      // 新词
      h('div', {},
        h('div', { class: 'row', style: 'margin-bottom:6px' },
          h('span', { style: 'font-size:14px;font-weight:600', text: '新词' }),
          h('span', { class: 'spacer' }),
          h('span', { class: 'tiny muted', text: `${d.newDone} / ${d.newTotal}` })),
        h('div', { class: 'progress' }, h('i', { style: `width:${newProgress}%` })),
        d.carriedCount > 0
          ? h('div', { class: 'tiny', style: 'color:var(--warn);margin-top:5px',
              text: `其中 ${d.carriedCount} 个是昨天没完成的` })
          : null),
      // 复习
      h('div', {},
        h('div', { class: 'row', style: 'margin-bottom:6px' },
          h('span', { style: 'font-size:14px;font-weight:600', text: '旧词复习' }),
          h('span', { class: 'spacer' }),
          h('span', { class: 'tiny muted', text: `${d.reviewDone} / ${d.reviewTotal}` })),
        h('div', { class: 'progress ok' }, h('i', { style: `width:${reviewProgress}%` }))),
      d.reinforceLeft > 0
        ? h('div', { class: 'notice warn' }, icon('alert', 16),
            h('div', { text: `还有 ${d.reinforceLeft} 个错词等待强化` }))
        : null
    )
  );

  const actions = h('div', { class: 'stack' },
    h('button', {
      class: 'btn ' + (d.newLeft > 0 ? 'btn-primary' : 'btn-outline') + ' btn-block',
      disabled: d.newLeft === 0 && d.reinforceLeft === 0,
      onclick: () => startSession('new'),
    }, icon('play'), d.newLeft > 0 ? `开始新词学习（${d.newLeft}）` : (d.reinforceLeft ? `继续强化（${d.reinforceLeft}）` : '新词已完成')),
    h('button', {
      class: 'btn ' + (d.reviewLeft > 0 ? 'btn-primary' : 'btn-outline') + ' btn-block',
      disabled: d.reviewLeft === 0,
      onclick: () => startSession('review'),
    }, icon('refresh'), d.reviewLeft > 0 ? `开始旧词复习（${d.reviewLeft}）` : '暂无到期复习')
  );

  const overview = h('div', { class: 'stat-grid three' },
    h('div', { class: 'stat' }, h('div', { class: 'k', text: '词库总量' }), h('div', { class: 'v', text: String(st.totalWords) })),
    h('div', { class: 'stat info' }, h('div', { class: 'k', text: '已学' }), h('div', { class: 'v', text: String(st.studied) })),
    h('div', { class: 'stat ok' }, h('div', { class: 'k', text: '已掌握' }), h('div', { class: 'v', text: String(st.mastered) }))
  );

  const pendingCheck = S.db.get(
    `SELECT COUNT(*) AS c FROM words WHERE translation_check_status='pending'`
  ).c;

  return h('div', { class: 'stack' },
    planCard,
    card,
    actions,
    allDone ? h('div', { class: 'notice info' }, icon('check', 16),
      h('div', { text: '今天的任务都完成了，做得好。' })) : null,
    overview,
    pendingCheck > 0
      ? h('div', { class: 'card' },
          h('div', { class: 'card-body' },
            h('div', { class: 'row' },
              icon('info', 18),
              h('div', { class: 'spacer' }),
              h('button', { class: 'btn btn-sm btn-primary', onclick: () => runTranslationCheck() },
                '核对翻译（' + pendingCheck + '）'))))
      : null,
    h('button', { class: 'btn btn-outline btn-block', onclick: () => navigate('import') },
      icon('upload'), '导入更多单词')
  );
}

/* ================================================================
 *  学习计划
 * ================================================================ */
function screenPlan() {
  const settings = getSettings(S.db);
  const active = getActivePlan(S.db);
  const prog = planProgress(S.db);

  let perDay = parseInt(String(active ? active.words_per_day : (settings.daily_new_target || '50')), 10);
  if (!Number.isFinite(perDay) || perDay < 1) perDay = 50;
  let spelling = active ? active.spelling_enabled === 1 : settings.spelling_enabled !== '0';

  const wrap = h('div', { class: 'stack' });
  const unlearnedNow = countUnlearnedWords(S.db);

  // ---- 当前计划 ----
  if (active && prog) {
    wrap.appendChild(h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', { text: '当前计划进行中' }),
        h('span', { class: 'hint', text: `第 ${prog.dayIndex} 天 / 共 ${prog.plannedDays} 天` })),
      h('div', { class: 'card-body stack' },
        h('div', { class: 'row', style: 'margin-bottom:6px' },
          h('span', { class: 'tiny muted', text: `${active.started_at} 开始` }),
          h('span', { class: 'spacer' }),
          h('span', { class: 'tiny muted', text: `${prog.learned} / ${prog.target} 词` })),
        h('div', { class: 'progress ok' }, h('i', { style: `width:${prog.percent}%` })),
        h('div', { class: 'hint-text', text: `预计 ${prog.finishDate} 背完。` }))));
  }

  // ---- 实时预览 ----
  const preview = h('div', { class: 'card' });
  function renderPreview() {
    const e = estimatePlan(S.db, perDay, today());
    preview.innerHTML = '';
    preview.appendChild(h('div', { class: 'card-head' }, h('h3', { text: '预计完成情况' })));
    preview.appendChild(h('div', { class: 'card-body stack' },
      h('div', { class: 'stat-grid three' },
        h('div', { class: 'stat' },
          h('div', { class: 'k', text: '待学单词' }),
          h('div', { class: 'v', text: String(e.unlearned) })),
        h('div', { class: 'stat info' },
          h('div', { class: 'k', text: '每天' }),
          h('div', { class: 'v', text: String(e.perDay) })),
        h('div', { class: 'stat ok' },
          h('div', { class: 'k', text: '需要天数' }),
          h('div', { class: 'v', text: String(e.days) }))),
      e.unlearned > 0
        ? h('div', { class: 'notice info' }, icon('info', 16),
            h('div', { text: `按每天 ${e.perDay} 词，从 ${e.startDate} 开始，预计 ${e.finishDate} 背完这 ${e.unlearned} 个词。` }))
        : h('div', { class: 'notice warn' }, icon('alert', 16),
            h('div', { text: '目前没有待学的单词。先去导入一批单词表吧。' }))));
  }

  const perInput = h('input', {
    class: 'input', type: 'number', min: '1', max: '200', value: String(perDay),
    oninput: () => {
      perDay = Math.max(1, Math.min(200, parseInt(perInput.value, 10) || 1));
      renderPreview();
    },
  });

  const spellToggle = h('input', { type: 'checkbox' });
  spellToggle.checked = spelling;
  spellToggle.addEventListener('change', () => { spelling = spellToggle.checked; });

  renderPreview();

  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', { text: active ? '调整计划参数' : '制定学习计划' })),
    h('div', { class: 'card-body stack' },
      h('div', { class: 'field' },
        h('label', { text: '每天背多少新词' }),
        perInput,
        h('div', { class: 'hint-text', text: '上次没背完的会占用下一天的名额，总天数不会因此变长。' })),
      h('label', { class: 'row top', style: 'cursor:pointer' },
        spellToggle,
        h('div', {},
          h('div', { style: 'font-size:14px;font-weight:600', text: '拼写模式' }),
          h('div', { class: 'hint-text', style: 'margin-top:2px',
            text: '打开后会出「看中文拼英文」的题；关掉就只做选择题。' }))))));

  wrap.appendChild(preview);

  wrap.appendChild(h('button', {
    class: 'btn btn-primary btn-block',
    disabled: unlearnedNow === 0 && !active,
    onclick: async () => {
      if (active) {
        const ok = await confirmDialog({
          title: '重新制定计划？',
          message: '当前计划会被结束，今天还没做的新词任务会作废。',
          detail: '已经学会的单词和复习进度不受影响。',
          confirmText: '重新开始',
        });
        if (!ok) return;
      }
      const res = startPlan(S.db, { wordsPerDay: perDay, spellingEnabled: spelling, date: today() });
      S.settings = getSettings(S.db);
      ensureDailyTasks(S.db, S.date);      // 立刻把今天的任务排出来
      scheduleSave();
      toast(`计划已开始：每天 ${res.wordsPerDay} 词，共 ${res.targetWords} 词`, 'ok', 2800);
      navigate('home');
    },
  }, icon('play'), active ? '重新开始计划' : '开始学习计划'));

  if (active) {
    wrap.appendChild(h('button', {
      class: 'btn btn-outline btn-block',
      onclick: async () => {
        const ok = await confirmDialog({
          title: '结束当前计划？',
          message: '结束后不再自动安排新词。',
          detail: '到期的旧词复习仍会继续。',
          confirmText: '结束计划',
          danger: true,
        });
        if (!ok) return;
        cancelPlan(S.db, today());
        scheduleSave();
        toast('计划已结束', 'ok');
        navigate('home');
      },
    }, '结束当前计划'));
  }

  wrap.appendChild(h('div', { class: 'hint-text',
    text: '开始之后就不用每天再点一次了 —— 每天打开 App 会自动把当天的任务排好。' }));

  return wrap;
}

/* ================================================================
 *  导入
 * ================================================================ */
function screenImport() {
  const wrap = h('div', { class: 'stack' });

  const ta = h('textarea', {
    class: 'textarea',
    placeholder: '每行一个单词，例如：\n\napple 苹果\nabandon 放弃\naccurate 准确的\nachieve 实现\n\n支持空格、Tab、逗号、冒号分隔，也支持「英文 | 词性 | 释义」的多列格式。',
  });

  const fileInput = h('input', {
    type: 'file', accept: '.docx', style: 'display:none',
    onchange: async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      await importDocx(f);
      e.target.value = '';
    },
  });

  const paste = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', { text: '粘贴单词表' })),
    h('div', { class: 'card-body stack' },
      ta,
      h('button', { class: 'btn btn-primary btn-block', onclick: () => importPasted(ta.value) },
        '解析并预览')));

  const file = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', { text: '上传 Word 文档' }),
      h('span', { class: 'hint', text: '.docx' })),
    h('div', { class: 'card-body stack' },
      h('div', { class: 'notice' }, icon('info', 16),
        h('div', { text: '文件在手机本地解析，不会上传到任何服务器。支持两列表格、三列（英文/词性/中文）、四列（含音标）以及纯段落格式。' })),
      fileInput,
      h('button', { class: 'btn btn-block', onclick: () => fileInput.click() },
        icon('upload'), '选择 .docx 文件')));

  wrap.appendChild(paste);
  wrap.appendChild(file);
  return wrap;
}

async function importPasted(text) {
  if (!text || !text.trim()) { toast('请先粘贴内容', 'warn'); return; }
  const rows = parsePastedText(text);
  if (!rows.length) { toast('没有解析到有效单词', 'bad'); return; }
  showPreview(rows, 'paste', '粘贴导入');
}

async function importDocx(file) {
  if (file.size > 20 * 1024 * 1024) { toast('文件太大（>20MB）', 'bad'); return; }
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const res = parseDocxBuffer(buf, window.fflate.unzipSync);
    if (res.error) { toast(res.error, 'bad', 3200); return; }
    showPreview(res.rows, 'docx', file.name.replace(/\.docx$/i, ''));
  } catch (e) {
    toast('解析失败：' + e.message, 'bad');
  }
}

function showPreview(rawRows, sourceType, listName) {
  const preview = buildImportPreview(S.db, rawRows);
  if (!preview.rows.length) { toast('没有可导入的单词', 'warn'); return; }

  const state = preview.rows.map((r) => ({ ...r }));

  const bodyEl = h('div', { class: 'stack' });

  const stats = h('div', { class: 'notice info' }, icon('info', 16),
    h('div', {},
      `解析到 ${preview.rows.length} 个单词：` +
      `新增 ${preview.stats.newWords}，已存在 ${preview.stats.existingWords}` +
      (preview.stats.duplicatesRemoved ? `，合并重复 ${preview.stats.duplicatesRemoved} 行` : '') + '。'));

  const list = h('div', { class: 'list' });
  function renderList() {
    list.innerHTML = '';
    state.forEach((r, i) => {
      const badge = r.isExisting
        ? h('span', { class: 'badge info', text: '已存在' })
        : (r.issues.length ? h('span', { class: 'badge warn', text: '待确认' }) : h('span', { class: 'badge ok', text: '新词' }));

      const item = h('div', { class: 'list-item' },
        h('div', { class: 'main' },
          h('div', { class: 't' }, r.word,
            r.pos.length ? h('span', { class: 'tiny muted', style: 'font-weight:400', text: '  ' + r.pos.join('/') }) : null),
          h('div', { class: 's', text: r.originalTranslation || '（缺少释义）' }),
          r.issues.length ? h('div', { class: 'tiny', style: 'color:var(--warn)', text: r.issues.join('；') }) : null),
        h('div', { class: 'r' }, badge),
        h('button', {
          class: 'btn btn-sm btn-ghost',
          onclick: () => {
            state.splice(i, 1);
            renderList();
            updateCount();
          },
        }, icon('trash', 15))
      );
      list.appendChild(item);
    });
  }

  const countEl = h('span', { class: 'hint' });
  const updateCount = () => { countEl.textContent = `将导入 ${state.length} 个`; };

  renderList();
  updateCount();

  bodyEl.appendChild(stats);
  bodyEl.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { text: '导入预览' }), countEl), list));

  const importBtn = h('button', {
    class: 'btn btn-primary',
    disabled: state.length === 0,
    onclick: () => {
      const keep = state.filter((r) => r.keep !== false);
      if (!keep.length) return;
      const res = commitImport(S.db, { name: listName, sourceType, rows: keep });
      scheduleSave();
      m.close();
      toast(`导入完成：新增 ${res.inserted}，更新 ${res.updated}`, 'ok', 2600);
      navigate('home');
      setTimeout(() => {
        if (res.inserted + res.updated > 0) askCheck(res.listId);
      }, 400);
    },
  }, '确认导入');
  updateCount.call ? null : null;

  const m = sheet({
    title: '导入预览',
    body: bodyEl,
    footer: [h('button', { class: 'btn btn-outline', text: '取消', onclick: () => m.close() }), importBtn],
  });
}

async function askCheck(listId) {
  const ok = await confirmDialog({
    title: '核对翻译？',
    message: '是否现在用词典核对这批单词的中文释义？',
    detail: '核对会用到本机离线词典；如果联网，还会补充音标和例句。核对结果需要你确认后才会生效，原始释义不会被覆盖。',
    confirmText: '开始核对',
  });
  if (ok) runTranslationCheck();
}

/* ================================================================
 *  翻译核对
 * ================================================================ */
async function runTranslationCheck() {
  const pending = S.db.all(
    `SELECT id FROM words WHERE translation_check_status='pending' ORDER BY id`
  ).map((r) => r.id);

  if (!pending.length) { toast('没有待核对的单词', 'info'); return; }

  const prog = { done: 0, total: pending.length };
  const bar = h('i', { style: 'width:0%' });
  const label = h('div', { class: 'tiny muted', text: `0 / ${pending.length}` });
  const m = sheet({
    title: '正在核对翻译',
    body: h('div', { class: 'stack', style: 'padding:8px 0' },
      h('div', { class: 'progress' }, bar), label,
      h('div', { class: 'hint-text', text: '使用离线词典比对义项，联网时会补充音标与例句。' })),
  });

  // 分批，让 UI 有机会刷新
  const batchSize = 8;
  let results = [];
  let report = { total: 0, A: 0, B: 0, C: 0, D: 0, E: 0, needsReview: 0, onlineErrors: 0 };

  for (let i = 0; i < pending.length; i += batchSize) {
    const chunk = pending.slice(i, i + batchSize);
    const r = await checkWords(S.db, chunk, S.dictService, {
      allowOnline: S.settings.dict_online_enabled !== '0',
    });
    results = results.concat(r.results);
    for (const k of Object.keys(report)) report[k] += (r.report[k] || 0);
    prog.done = Math.min(pending.length, i + batchSize);
    bar.style.width = Math.round((prog.done / prog.total) * 100) + '%';
    label.textContent = `${prog.done} / ${prog.total}`;
    await new Promise((res) => setTimeout(res, 0));
  }

  scheduleSave();
  m.close();
  S.checkResult = { results, report };
  toast(`核对完成：正确 ${report.A}，需关注 ${report.needsReview}`, 'ok', 3000);
  navigate('check');
}

const STATUS_META = {
  A: { label: '正确', cls: 'ok' },
  B: { label: '不完整', cls: 'warn' },
  C: { label: '可能有误', cls: 'warn' },
  D: { label: '确认错误', cls: 'bad' },
  E: { label: '无法确认', cls: 'mute' },
  confirmed: { label: '已确认', cls: 'ok' },
  pending: { label: '待核对', cls: 'mute' },
};

function screenCheckReport() {
  const r = S.checkResult;
  if (!r) {
    return h('div', { class: 'empty' }, icon('info'),
      h('div', { class: 't', text: '还没有核对结果' }),
      h('div', { class: 's', text: '回到首页点击「核对翻译」' }),
      h('button', { class: 'btn btn-primary mt', onclick: () => navigate('home') }, '回首页'));
  }

  const rep = r.report;
  const filterState = { status: 'all' };
  const listEl = h('div', { class: 'list' });

  function renderList() {
    listEl.innerHTML = '';
    const items = r.results.filter((x) => filterState.status === 'all' || x.status === filterState.status);
    if (!items.length) {
      listEl.appendChild(h('div', { class: 'empty' }, h('div', { class: 's', text: '没有符合筛选的单词' })));
      return;
    }
    for (const it of items.slice(0, 200)) {
      const meta = STATUS_META[it.status] || STATUS_META.E;
      listEl.appendChild(h('div', {
        class: 'list-item',
        onclick: () => openWordCheck(it),
      },
        h('div', { class: 'main' },
          h('div', { class: 't', text: it.word }),
          h('div', { class: 's', text: it.details ? it.details.userSenses.join('；') : '' })),
        h('div', { class: 'r' }, h('span', { class: 'badge ' + meta.cls, text: meta.label }))
      ));
    }
  }

  const chips = h('div', { class: 'row-wrap', style: 'gap:8px' });
  const filters = [
    ['all', `全部 ${rep.total}`],
    ['A', `正确 ${rep.A}`],
    ['B', `不完整 ${rep.B}`],
    ['C', `可能错 ${rep.C}`],
    ['D', `错误 ${rep.D}`],
    ['E', `待确认 ${rep.E}`],
  ];
  filters.forEach(([k, label]) => {
    chips.appendChild(h('button', {
      class: 'btn btn-sm ' + (k === 'all' ? 'btn-primary' : 'btn-outline'),
      dataset: { status: k },
      onclick: (e) => {
        filterState.status = k;
        chips.querySelectorAll('button').forEach((b) => {
          b.className = 'btn btn-sm ' + (b.dataset.status === k ? 'btn-primary' : 'btn-outline');
        });
        renderList();
      },
    }, label));
  });

  renderList();

  return h('div', { class: 'stack' },
    h('div', { class: 'stat-grid three' },
      h('div', { class: 'stat ok' }, h('div', { class: 'k', text: '正确' }), h('div', { class: 'v', text: String(rep.A) })),
      h('div', { class: 'stat warn' }, h('div', { class: 'k', text: '需关注' }), h('div', { class: 'v', text: String(rep.needsReview) })),
      h('div', { class: 'stat' }, h('div', { class: 'k', text: '总数' }), h('div', { class: 'v', text: String(rep.total) }))),
    rep.onlineErrors > 0
      ? h('div', { class: 'notice warn' }, icon('alert', 16),
          h('div', { text: `有 ${rep.onlineErrors} 个词在线词典查询失败（不影响离线核对结果）。` }))
      : null,
    chips,
    h('div', { class: 'card' }, listEl),
    h('div', { class: 'hint-text', text: '点开单词可以查看原始释义、词典参考和系统建议，并决定如何处理。' })
  );
}

function openWordCheck(it) {
  const w = S.db.get('SELECT * FROM words WHERE word=?', [it.word]);
  const meta = STATUS_META[it.status] || STATUS_META.E;
  const refs = it.details ? it.details.refSenses : [];

  const body = h('div', { class: 'stack' },
    h('div', { class: 'row' },
      h('span', { class: 't', style: 'font-size:22px;font-weight:700', text: it.word }),
      h('span', { class: 'spacer' }),
      h('span', { class: 'badge ' + meta.cls, text: meta.label })),
    h('div', { class: 'field' }, h('label', { text: 'Word 原始释义' }),
      h('div', { style: 'font-size:15px', text: it.details ? it.details.userSenses.join('；') : '—' })),
    h('div', { class: 'field' }, h('label', { text: '词典参考释义' }),
      h('div', { style: 'font-size:14px;color:var(--text-2)', text: refs.length ? refs.join('；') : '（词典未收录）' })),
    it.suggested ? h('div', { class: 'field' }, h('label', { text: '系统建议修改为' }),
      h('div', { style: 'font-size:15px;color:var(--info)', text: it.suggested })) : null,
    h('div', { class: 'field' }, h('label', { text: '核对说明' }),
      h('div', { class: 'hint-text', text: it.reason })),
    h('div', { class: 'field' }, h('label', { text: '置信度 / 来源' }),
      h('div', { class: 'hint-text',
        text: `${Math.round((it.confidence || 0) * 100)}% · ${(it.sources || []).join('、') || '无'}` })),
    h('div', { class: 'notice info' }, icon('info', 16),
      h('div', { text: '原始释义不会被自动覆盖。请选择如何处理：' }))
  );

  const manualInput = h('input', { class: 'input', placeholder: '输入你的最终释义' });

  const act = (action) => {
    const res = applyCheckDecision(S.db, w.id, action, action === 'manual' ? manualInput.value : null);
    if (!res.ok) { toast(res.error || '操作失败', 'bad'); return; }
    scheduleSave();
    m.close();
    toast('已保存', 'ok', 1400);
    // 更新本地报告
    it.status = action === 'keep' ? 'A' : 'confirmed';
    render();
  };

  const m = sheet({
    title: '核对详情',
    body,
    footer: [
      h('button', { class: 'btn btn-outline btn-sm', onclick: () => act('keep') }, '保留原文'),
      h('button', {
        class: 'btn btn-primary btn-sm',
        disabled: !it.suggested,
        onclick: () => act('adopt'),
      }, '采用建议'),
    ],
  });

  m.body.appendChild(h('div', { class: 'stack', style: 'margin-top:8px' },
    h('div', { class: 'field' }, h('label', { text: '或手动修改' }), manualInput),
    h('button', { class: 'btn btn-block', onclick: () => act('manual') }, '保存手工释义')));
}

/* ================================================================
 *  学习
 * ================================================================ */
function screenStudy() {
  if (!S.session) {
    const d = summarizeDay(S.db, S.date);
    const pending = getPendingQueue(S.db, S.date);
    return h('div', { class: 'stack' },
      h('div', { class: 'empty' }, icon('book'),
        h('div', { class: 't', text: '准备好了就开始' }),
        h('div', { class: 's', text: `今日待办 ${pending.length} 项` })),
      h('button', {
        class: 'btn btn-primary btn-block',
        disabled: d.newLeft === 0 && d.reinforceLeft === 0,
        onclick: () => startSession('new'),
      }, icon('play'), `新词学习（${d.newLeft + d.reinforceLeft}）`),
      h('button', {
        class: 'btn btn-block',
        disabled: d.reviewLeft === 0,
        onclick: () => startSession('review'),
      }, icon('refresh'), `旧词复习（${d.reviewLeft}）`));
  }
  return renderSession();
}

function startSession(kind) {
  S.session = { kind, stats: { done: 0, correct: 0 }, answered: false, current: null, lastFeedback: null };
  navigate('study');
  nextQuestion();
}

function nextQuestion() {
  const s = S.session;
  if (!s) return;

  let queue = getPendingQueue(S.db, S.date);
  if (s.kind === 'new') {
    queue = queue.filter((r) => r.kind === 'new' || r.kind === 'reinforce');
  } else {
    queue = queue.filter((r) => r.kind === 'review' || r.kind === 'reinforce');
  }

  if (!queue.length) {
    s.current = null;
    s.answered = false;
    s.lastFeedback = null;
    s.skippedWords = 0;
    render();
    return;
  }

  const types = activeTypes(
    S.settings.spelling_enabled !== '0',
    S.settings.question_types || 'en2cn,cn2en,spell,en2def'
  );

  // 没有释义 / 干扰项不足的词无法出题，跳过而不是给用户一道空题
  let picked = null;
  let skipped = 0;

  for (const item of queue) {
    const wordRow = S.db.get('SELECT * FROM words WHERE id=?', [item.word_id]);
    if (!wordRow) { skipped++; continue; }

    const pool = S.db.all(
      `SELECT w.* FROM words w WHERE w.id <> ? ORDER BY RANDOM() LIMIT 60`, [item.word_id]
    );
    const q = buildQuestion(wordRow, [wordRow, ...pool], {
      types, rng: makeRng(Date.now() + item.word_id),
    });
    if (!q) { skipped++; continue; }

    picked = { item, word: wordRow, q };
    break;
  }

  s.skippedWords = skipped;

  if (!picked) {
    s.current = null;
    s.answered = false;
    s.lastFeedback = null;
    render();
    return;
  }

  s.current = picked;
  s.answered = false;
  s.lastFeedback = null;
  render();
}

function renderSession() {
  const s = S.session;
  const d = summarizeDay(S.db, S.date);

  if (!s.current) {
    const done = s.stats.done;
    return h('div', { class: 'stack' },
      h('div', { class: 'empty' }, icon('check'),
        h('div', { class: 't', text: s.kind === 'new' ? '今天的新词已完成' : '今天的复习已完成' }),
        h('div', { class: 's', text: `本轮作答 ${done} 题，正确 ${s.stats.correct} 题` })),
      s.skippedWords > 0
        ? h('div', { class: 'notice warn' }, icon('alert', 16),
            h('div', { text: `有 ${s.skippedWords} 个单词缺少中文释义，无法出题，已跳过。可以到「词库」里补全释义。` }))
        : null,
      h('button', { class: 'btn btn-primary btn-block', onclick: () => { S.session = null; navigate('home'); } }, '回到首页'),
      s.kind === 'new' && d.reviewLeft > 0
        ? h('button', { class: 'btn btn-block', onclick: () => startSession('review') },
            `继续旧词复习（${d.reviewLeft}）`)
        : null);
  }

  const { q, item } = s.current;
  const totalToday = s.kind === 'new' ? d.newTotal : d.reviewTotal;
  const doneToday = s.kind === 'new' ? d.newDone : d.reviewDone;
  const pct = totalToday ? Math.min(100, Math.round((doneToday / totalToday) * 100)) : 0;

  const wrap = h('div', { class: 'study-wrap' });

  wrap.appendChild(h('div', { class: 'row' },
    h('button', { class: 'icon-btn', onclick: () => { S.session = null; navigate('home'); } }, icon('back')),
    h('div', { class: 'progress' }, h('i', { style: `width:${pct}%` })),
    h('span', { class: 'tiny muted nowrap', text: `${doneToday}/${totalToday}` })
  ));

  if (item.kind === 'reinforce') {
    wrap.appendChild(h('div', { class: 'notice warn' }, icon('refresh', 16),
      h('div', { text: '这是刚才答错的词，再记一次' })));
  }

  // 题面
  const qcard = h('div', { class: 'qcard' },
    h('div', { class: 'qkind', text: QTYPE[q.type] + (item.kind === 'review' ? ' · 复习' : '') }),
    h('div', { class: 'qmain' + (q.promptKind === 'cn' ? ' cn' : ''), text: q.prompt }),
    q.promptSub ? h('div', { class: 'qsub', text: q.promptSub }) : null,
    q.hint ? h('div', { class: 'tiny muted', text: q.hint }) : null
  );
  wrap.appendChild(qcard);

  if (!s.answered) {
    if (q.type === 'spell') {
      const input = h('input', {
        class: 'input spell-input', type: 'text', autocomplete: 'off',
        autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
        placeholder: '输入英文单词',
      });
      const submit = () => {
        const val = input.value;
        if (!val.trim()) { toast('请输入答案', 'warn'); return; }
        submitAnswer(val, input);
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      wrap.appendChild(h('div', { class: 'stack' }, input,
        h('button', { class: 'btn btn-primary btn-block', onclick: submit }, '提交')));
      setTimeout(() => input.focus(), 60);
    } else {
      q.options.forEach((opt, i) => {
        wrap.appendChild(h('button', {
          class: 'opt',
          onclick: (e) => {
            submitAnswer(i, e.currentTarget);
          },
        }, h('span', { class: 'idx', text: String.fromCharCode(65 + i) }),
           h('span', { text: opt })));
      });
    }
  } else {
    // 反馈
    const fb = s.lastFeedback;
    const box = h('div', { class: 'feedback ' + (fb.correct ? 'ok' : 'bad') },
      h('div', { class: 'fhead' },
        icon(fb.correct ? 'check' : 'alert', 18),
        h('span', { text: fb.correct ? '回答正确' : '答错了' })),
      h('div', { class: 'word', text: s.current.word.display_word || s.current.word.word }),
      h('div', { class: 'ipa',
        text: [s.current.word.uk_ipa, s.current.word.us_ipa].filter(Boolean).join('  ') || '（无音标）' }),
      h('div', { class: 'cn', text: s.current.word.confirmed_translation || s.current.word.original_translation || '—' }),
      s.current.word.english_example
        ? h('div', { class: 'ex' },
            s.current.word.english_example,
            s.current.word.example_translation
              ? h('div', { class: 'ex' }, h('em', { text: s.current.word.example_translation }))
              : null)
        : null,
      !fb.correct && fb.close ? h('div', { class: 'tiny', style: 'margin-top:8px', text: fb.close }) : null
    );
    wrap.appendChild(box);

    const isLast = false;
    wrap.appendChild(h('button', {
      class: 'btn btn-primary btn-block',
      onclick: () => nextQuestion(),
    }, '继续'));
  }

  return wrap;
}

function submitAnswer(response, node) {
  const s = S.session;
  const { q, item } = s.current;
  const g = gradeAnswer(q, response);

  // 高亮选项
  if (q.type !== 'spell' && node) {
    const opts = node.parentNode.querySelectorAll('.opt');
    opts.forEach((o, i) => {
      o.disabled = true;
      if (i === q.answerIndex) o.classList.add('correct');
      else if (i === response) o.classList.add('wrong');
    });
  }

  let close = '';
  if (!g.correct && q.type === 'spell') {
    const d = levenshtein(normalizeWord(response), normalizeWord(q.answer));
    if (d <= 2) close = `拼写接近，只差 ${d} 个字母`;
  }

  const res = recordAnswer(S.db, {
    wordId: item.word_id,
    mode: item.kind,
    questionType: q.type,
    isCorrect: g.correct,
    userAnswer: String(response),
    taskId: item.task_id,
    date: S.date,
  });

  s.stats.done++;
  if (g.correct) s.stats.correct++;
  s.answered = true;
  s.lastFeedback = { correct: g.correct, close, reinforce: res.reinforceQueued };

  // 全部背完就把计划收尾（不能一直挂着"进行中"）
  try { closePlanIfDone(S.db, S.date); } catch (e) { /* 不影响答题 */ }

  scheduleSave();
  render();
}

/* ================================================================
 *  词库
 * ================================================================ */
function screenLibrary() {
  const f = S.libraryFilter;
  const wrap = h('div', { class: 'stack' });

  const search = h('input', {
    class: 'input', type: 'search', placeholder: '搜索单词或释义',
    value: f.q,
    oninput: debounce((e) => { f.q = e.target.value; f.offset = 0; refresh(); }, 220),
  });

  const stateSel = h('select', {
    class: 'select',
    onchange: (e) => { f.state = e.target.value; f.offset = 0; refresh(); },
  },
    h('option', { value: 'all', text: '全部状态' }),
    ...Object.entries(STATE_LABEL).map(([k, v]) => h('option', { value: k, text: v }))
  );
  stateSel.value = f.state;

  const listCard = h('div', { class: 'card' });
  const moreBtn = h('button', { class: 'btn btn-block btn-outline', onclick: () => { f.offset += 50; refresh(); } });

  function refresh() {
    const res = searchWords(S.db, { q: f.q, state: f.state, limit: 50, offset: f.offset });
    listCard.innerHTML = '';
    const head = h('div', { class: 'card-head' },
      h('h3', { text: '词库' }), h('span', { class: 'hint', text: `共 ${res.total} 个` }));
    listCard.appendChild(head);

    if (!res.rows.length) {
      listCard.appendChild(h('div', { class: 'empty' }, icon('search'),
        h('div', { class: 's', text: '没有匹配的单词' })));
      moreBtn.remove();
      return;
    }

    const listEl = h('div', { class: 'list flush' });
    for (const w of res.rows) {
      const stLabel = STATE_LABEL[w.state || 'new'] || '未学习';
      listEl.appendChild(h('div', { class: 'list-item', onclick: () => openWordDetail(w) },
        h('div', { class: 'main' },
          h('div', { class: 't' },
            w.display_word || w.word,
            (w.total_wrong > 0) ? h('span', { class: 'badge bad', style: 'margin-left:6px', text: '错' + w.total_wrong }) : null),
          h('div', { class: 's', text: w.confirmed_translation || w.original_translation || '（无释义）' })),
        h('div', { class: 'r' },
          h('span', { class: 'badge ' + (w.state === 'mastered' ? 'ok' : w.state === 'fragile' ? 'bad' : 'mute'), text: stLabel }))
      ));
    }
    listCard.appendChild(listEl);

    if (res.total > f.offset + res.rows.length) {
      moreBtn.textContent = `加载更多（还有 ${res.total - f.offset - res.rows.length} 个）`;
      listCard.appendChild(h('div', { style: 'padding:12px 16px' }, moreBtn));
    }
  }

  refresh();
  wrap.appendChild(h('div', { class: 'row', style: 'gap:8px' }, search));
  wrap.appendChild(stateSel);
  wrap.appendChild(listCard);
  return wrap;
}

function openWordDetail(w) {
  const rs = S.db.get('SELECT * FROM review_schedule WHERE word_id=?', [w.id]) || {};
  const body = h('div', { class: 'stack' },
    h('div', {},
      h('div', { style: 'font-size:24px;font-weight:700', text: w.display_word || w.word }),
      h('div', { class: 'mono tiny muted', text: [w.uk_ipa, w.us_ipa].filter(Boolean).join('  ') || '（无音标）' })),
    h('div', { class: 'field' }, h('label', { text: '释义' }),
      h('div', { style: 'font-size:15px', text: w.confirmed_translation || w.original_translation || '—' })),
    w.original_translation && w.confirmed_translation
      ? h('div', { class: 'field' }, h('label', { text: 'Word 原始释义' }),
          h('div', { class: 'hint-text', text: w.original_translation }))
      : null,
    w.english_example ? h('div', { class: 'field' }, h('label', { text: '例句' }),
      h('div', { class: 'hint-text', text: w.english_example }),
      w.example_translation ? h('div', { class: 'hint-text', text: w.example_translation }) : null) : null,
    h('div', { class: 'stat-grid' },
      h('div', { class: 'stat' }, h('div', { class: 'k', text: '记忆状态' }),
        h('div', { class: 'v', style: 'font-size:17px', text: STATE_LABEL[rs.state || 'new'] || '未学习' })),
      h('div', { class: 'stat' }, h('div', { class: 'k', text: '复习间隔' }),
        h('div', { class: 'v', style: 'font-size:17px', text: (rs.interval_days || 0) + ' 天' }))),
    h('div', { class: 'stat-grid three' },
      h('div', { class: 'stat' }, h('div', { class: 'k', text: '答对' }), h('div', { class: 'v', text: String(rs.total_correct || 0) })),
      h('div', { class: 'stat' }, h('div', { class: 'k', text: '答错' }), h('div', { class: 'v', text: String(rs.total_wrong || 0) })),
      h('div', { class: 'stat' }, h('div', { class: 'k', text: '难度' }), h('div', { class: 'v', style: 'font-size:17px', text: (rs.ease || 2.3).toFixed(1) }))),
    rs.due_at ? h('div', { class: 'hint-text', text: '下次复习：' + rs.due_at }) : null
  );

  const m = sheet({
    title: '单词详情',
    body,
    footer: [
      h('button', {
        class: 'btn btn-danger',
        onclick: async () => {
          const ok = await confirmDialog({
            title: '删除单词？',
            message: `将删除「${w.word}」及其全部学习记录。`,
            detail: '此操作不可撤销。',
            confirmText: '删除', danger: true,
          });
          if (!ok) return;
          deleteWord(S.db, w.id);
          scheduleSave();
          m.close();
          toast('已删除', 'ok');
          render();
        },
      }, icon('trash', 16), '删除'),
      h('button', { class: 'btn btn-primary', onclick: () => { m.close(); editWord(w); } }, '修改资料'),
    ],
  });
}

function editWord(w) {
  const tr = h('input', { class: 'input', value: w.confirmed_translation || w.original_translation || '' });
  const uk = h('input', { class: 'input', value: w.uk_ipa || '', placeholder: '/.../' });
  const ex = h('textarea', { class: 'textarea', style: 'min-height:80px', value: w.english_example || '' });
  const exCn = h('input', { class: 'input', value: w.example_translation || '' });

  const body = h('div', { class: 'stack' },
    h('div', { class: 'field' }, h('label', { text: '释义' }), tr),
    h('div', { class: 'field' }, h('label', { text: '英式音标' }), uk),
    h('div', { class: 'field' }, h('label', { text: '例句' }), ex),
    h('div', { class: 'field' }, h('label', { text: '例句翻译' }), exCn),
    h('div', { class: 'notice info' }, icon('info', 16),
      h('div', { text: 'Word 原始释义始终保留，这里的修改只影响确认释义。' }))
  );

  const m = sheet({
    title: '修改 ' + (w.display_word || w.word),
    body,
    footer: [
      h('button', { class: 'btn btn-outline', text: '取消', onclick: () => m.close() }),
      h('button', {
        class: 'btn btn-primary', text: '保存',
        onclick: () => {
          updateWord(S.db, w.id, {
            confirmed_translation: tr.value,
            uk_ipa: uk.value,
            english_example: ex.value,
            example_translation: exCn.value,
          });
          scheduleSave();
          m.close();
          toast('已保存', 'ok');
          render();
        },
      }),
    ],
  });
}

/* ================================================================
 *  统计
 * ================================================================ */
function screenStats() {
  const st = getStats(S.db);
  const total = st.totalWords || 1;

  const bar = (label, value, cls) => {
    const pct = Math.round((value / total) * 100);
    return h('div', {},
      h('div', { class: 'row', style: 'margin-bottom:5px' },
        h('span', { class: 'tiny', text: label }),
        h('span', { class: 'spacer' }),
        h('span', { class: 'tiny muted', text: `${value} 个 · ${pct}%` })),
      h('div', { class: 'progress ' + cls }, h('i', { style: `width:${Math.max(pct, value ? 2 : 0)}%` })));
  };

  return h('div', { class: 'stack' },
    h('div', { class: 'stat-grid three' },
      h('div', { class: 'stat' }, h('div', { class: 'k', text: '词库总量' }), h('div', { class: 'v', text: String(st.totalWords) })),
      h('div', { class: 'stat info' }, h('div', { class: 'k', text: '已学习' }), h('div', { class: 'v', text: String(st.studied) })),
      h('div', { class: 'stat ok' }, h('div', { class: 'k', text: '已掌握' }), h('div', { class: 'v', text: String(st.mastered) }))),

    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { text: '记忆状态分布' })),
      h('div', { class: 'card-body stack' },
        bar('已掌握', st.mastered, 'ok'),
        bar('待巩固', st.consolidating, ''),
        bar('正在学习', st.learning, ''),
        bar('容易遗忘', st.fragile, ''),
        bar('未学习', st.newWords, ''))),

    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { text: '答题统计' })),
      h('div', { class: 'card-body' },
        h('div', { class: 'stat-grid' },
          h('div', { class: 'stat' }, h('div', { class: 'k', text: '累计答题' }), h('div', { class: 'v', text: String(st.totalAnswers) })),
          h('div', { class: 'stat ' + (st.accuracy >= 80 ? 'ok' : st.accuracy >= 60 ? 'warn' : 'bad') },
            h('div', { class: 'k', text: '正确率' }),
            h('div', { class: 'v', text: String(st.accuracy), }, h('small', { text: '%' })))),
        h('div', { class: 'row mt', style: 'gap:16px' },
          h('span', { class: 'tiny muted', text: `答对 ${st.correctAnswers}` }),
          h('span', { class: 'tiny muted', text: `答错 ${st.wrongAnswers}` })))),

    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { text: '近 14 天' })),
      h('div', { class: 'card-body' }, renderTrend(st.trend))),

    h('div', { class: 'notice info' }, icon('info', 16),
      h('div', { text: '所有数字都由本地数据库实时计算，没有使用任何模拟数据。' }))
  );
}

function renderTrend(trend) {
  if (!trend || !trend.length) {
    return h('div', { class: 'empty', style: 'padding:24px 0' },
      h('div', { class: 's', text: '还没有学习记录' }));
  }
  const max = Math.max(...trend.map((t) => t.answers), 1);
  const bars = h('div', { style: 'display:flex;align-items:flex-end;gap:6px;height:110px' });
  for (const t of trend) {
    const hgt = Math.max(4, Math.round((t.answers / max) * 100));
    const acc = t.answers ? Math.round((t.correct / t.answers) * 100) : 0;
    bars.appendChild(h('div', {
      style: 'flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:4px',
      title: `${t.date}：${t.answers} 题，正确率 ${acc}%`,
    },
      h('i', {
        style: `display:block;width:100%;height:${hgt}px;border-radius:4px;` +
          `background:${acc >= 80 ? 'var(--ok)' : acc >= 60 ? 'var(--warn)' : 'var(--bad)'}`
      }),
      h('span', { class: 'tiny muted', style: 'font-size:9px', text: t.date.slice(5) })
    ));
  }
  return bars;
}

/* ================================================================
 *  设置
 * ================================================================ */
function screenSettings() {
  const settings = getSettings(S.db);
  const lists = listWordLists(S.db);

  const targetInput = h('input', {
    class: 'input', type: 'number', min: '1', max: '200', value: settings.daily_new_target || '50',
    onchange: (e) => {
      const v = Math.max(1, Math.min(200, parseInt(e.target.value, 10) || 50));
      e.target.value = v;
      setSetting(S.db, 'daily_new_target', v);
      S.settings.daily_new_target = String(v);
      // 有进行中的计划时同步过去，避免两处数字不一致
      const plan = getActivePlan(S.db);
      if (plan) {
        S.db.run('UPDATE study_plan SET words_per_day=? WHERE id=?', [v, plan.id]);
      }
      scheduleSave();
      toast('每日新词数已设为 ' + v, 'ok');
    },
  });

  const spellToggle = h('input', { type: 'checkbox' });
  spellToggle.checked = settings.spelling_enabled !== '0';
  spellToggle.addEventListener('change', () => {
    const on = spellToggle.checked;
    setSetting(S.db, 'spelling_enabled', on ? '1' : '0');
    S.settings.spelling_enabled = on ? '1' : '0';
    const plan = getActivePlan(S.db);
    if (plan) S.db.run('UPDATE study_plan SET spelling_enabled=? WHERE id=?', [on ? 1 : 0, plan.id]);
    scheduleSave();
    toast(on ? '拼写模式已开启' : '拼写模式已关闭，只做选择题', 'ok');
  });

  const plan = getActivePlan(S.db);

  const onlineToggle = h('input', { type: 'checkbox' });
  onlineToggle.checked = settings.dict_online_enabled !== '0';
  onlineToggle.addEventListener('change', () => {
    setSetting(S.db, 'dict_online_enabled', onlineToggle.checked ? '1' : '0');
    S.settings.dict_online_enabled = onlineToggle.checked ? '1' : '0';
    scheduleSave();
    toast(onlineToggle.checked ? '已开启在线词典（可选）' : '已关闭在线词典，核对仅用离线词库', 'ok');
  });

  const listEl = h('div', { class: 'list flush' });
  for (const l of lists) {
    listEl.appendChild(h('div', { class: 'list-item' },
      h('div', { class: 'main' },
        h('div', { class: 't', text: l.name }),
        h('div', { class: 's', text: `${l.actual_count} 个单词 · ${l.source_type} · ${l.created_at}` })),
      h('button', {
        class: 'btn btn-sm btn-ghost',
        onclick: async () => {
          const ok = await confirmDialog({
            title: '删除词库？',
            message: `将删除词库「${l.name}」，并移除其中只属于这个词库的 ${l.actual_count} 个单词。`,
            detail: '这些单词的学习记录会一并清除。若某个单词还在其它词库里，则会保留。此操作不可撤销。',
            confirmText: '删除词库',
            danger: true,
          });
          if (!ok) return;
          const r = deleteWordList(S.db, l.id);
          scheduleSave();
          toast(
            r.removedWords > 0
              ? `已删除词库，同时移除 ${r.removedWords} 个单词`
              : '已删除词库（其单词仍被其它词库引用，已保留）',
            'ok', 2800
          );
          render();
        },
      }, icon('trash', 15))
    ));
  }

  const totalWordsNow = S.db.get('SELECT COUNT(*) AS c FROM words').c;

  const wipeBtn = h('button', {
    class: 'btn btn-danger btn-block',
    disabled: totalWordsNow === 0,
    onclick: async () => {
      if (totalWordsNow === 0) return;

      // 第一次确认
      const first = await confirmDialog({
        title: '删除全部数据？',
        message: `将永久删除 ${totalWordsNow} 个单词、全部词库、学习记录、复习计划与统计数据。`,
        detail: '此操作不可撤销。建议先点上面的「导出数据库备份」存一份。',
        confirmText: '继续',
        danger: true,
      });
      if (!first) return;

      // 第二次确认：必须手打文字
      const second = await confirmDialog({
        title: '再次确认',
        message: '最后一步。请手动输入「删除全部」以确认。',
        confirmText: '彻底删除',
        danger: true,
        requireText: '删除全部',
      });
      if (!second) return;

      const r = deleteAllData(S.db);
      S.session = null;
      S.checkResult = null;
      scheduleSave();
      toast(`已删除全部数据（${r.removedWords} 个单词）`, 'ok', 3000);
      navigate('home');
      render();
    },
  }, icon('trash', 18), '删除全部数据');

  const exportBtn = h('button', {
    class: 'btn btn-outline btn-block',
    onclick: async () => {
      const bytes = S.db.toBinary();
      const name = `词忆备份_${S.date}.sqlite`;

      // Android WebView 不支持 Blob 下载，走原生桥写进「下载」目录
      const bridge = window.AndroidBridge;
      if (bridge && typeof bridge.saveBase64 === 'function') {
        try {
          let bin = '';
          const chunk = 0x8000;
          for (let i = 0; i < bytes.length; i += chunk) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
          }
          const okSave = bridge.saveBase64(name, 'application/octet-stream', btoa(bin));
          toast(okSave ? '已保存到「下载」文件夹' : '保存失败', okSave ? 'ok' : 'bad');
        } catch (e) {
          toast('导出失败：' + e.message, 'bad');
        }
        return;
      }

      // 浏览器
      const blob = new Blob([bytes], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: name });
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 500);
      toast('已导出数据库备份', 'ok');
    },
  }, '导出数据库备份');

  return h('div', { class: 'stack' },
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { text: '学习设置' })),
      h('div', { class: 'card-body stack' },
        h('div', { class: 'field' },
          h('label', { text: '每日新词数量' }), targetInput,
          h('div', { class: 'hint-text', text: '默认 50 个。上次没完成的会占用今天的名额。' })),
        h('label', { class: 'row top', style: 'cursor:pointer' },
          spellToggle,
          h('div', {},
            h('div', { style: 'font-size:14px;font-weight:600', text: '拼写模式' }),
            h('div', { class: 'hint-text', style: 'margin-top:2px',
              text: '开启后会出「看中文拼英文」的题，关闭则只做选择题。' }))),
        h('button', {
          class: 'btn btn-block',
          onclick: () => navigate('plan'),
        }, icon('play'), plan ? '查看 / 调整学习计划' : '制定学习计划'))),

    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { text: '词典与核对' })),
      h('div', { class: 'card-body stack' },
        h('label', { class: 'row top', style: 'cursor:pointer' },
          onlineToggle,
          h('div', {},
            h('div', { style: 'font-size:14px;font-weight:600', text: '联网时补充音标与例句' }),
            h('div', { class: 'hint-text', style: 'margin-top:2px',
              text: '使用 dictionaryapi.dev（免费、无需密钥）。关闭后仅用本机离线词库，完全断网也能核对。' }))),
        h('div', { class: 'notice info' }, icon('info', 16),
          h('div', { text: `离线词库 ${S.dict ? S.dict.size.toLocaleString() : 0} 个词条，已内置在 App 内。` })))),

    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { text: '我的词库' }), h('span', { class: 'hint', text: `${lists.length} 个` })),
      listEl),

    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { text: '数据' })),
      h('div', { class: 'card-body stack' },
        exportBtn,
        h('div', { class: 'hint-text', text: '所有数据保存在本机 SQLite 数据库中，不上传任何服务器。' }),
        h('div', { class: 'divider' }),
        wipeBtn,
        h('div', { class: 'hint-text',
          text: `删除后本机将清空全部 ${totalWordsNow} 个单词与学习记录，需要二次确认。` }))),

    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { text: '关于' })),
      h('div', { class: 'card-body stack', style: 'gap:8px' },
        h('div', { class: 'hint-text', text: '词忆 v1.1.2 · 纯本地离线背单词' }),
        h('div', { class: 'hint-text', text: '词典数据来源：ECDICT（MIT 开源英汉词典）' }),
        h('div', { class: 'hint-text', text: '在线补充：dictionaryapi.dev' })))
  );
}

/* ================================================================
 *  工具
 * ================================================================ */
function debounce(fn, ms) {
  let t = null;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

/* ================================================================
 *  启动
 * ================================================================ */
async function boot() {
  const t0 = Date.now();
  const bootText = document.getElementById('bootText');
  const bootBar = document.getElementById('bootBar');
  const step = (pct, text) => {
    bootBar.style.width = pct + '%';
    if (text) bootText.textContent = text;
  };

  try {
    step(8, '初始化 SQLite 引擎…');
    const SQL = await initSqlJs({ locateFile: (f) => 'vendor/' + f });

    step(35, '加载离线英汉词典…');
    S.dict = await LocalDictionary.load('data/dict.json.gz');

    step(60, '加载中文近义词表…');
    try {
      await loadSynonymMap('data/syn.json.gz');
    } catch (e) {
      console.warn('近义词表加载失败，核对精度会略降', e);
    }

    step(75, '打开本地数据库…');
    const saved = await idbGet('db');
    S.db = createDB(SQL, saved || null, (bytes) => { idbPut('db', bytes); });
    S.db.migrate();

    S.settings = getSettings(S.db);
    applyTheme();

    step(90, '准备今日任务…');
    // 修复历史数据：早期版本会把行首序号当成单词的一部分（"10 exceptional"）
    try {
      const rep = repairNumberedWords(S.db);
      if (rep.fixed > 0) {
        console.log(`[词忆] 已修复 ${rep.fixed} 个带编号的单词`);
      }
    } catch (e) {
      console.warn('[词忆] 编号修复失败', e);
    }

    // 清理孤儿单词：不属于任何词库、却还在统计和出题里的历史遗留
    try {
      const pr = pruneOrphanWords(S.db);
      if (pr.removed > 0) {
        console.log(`[词忆] 已清理 ${pr.removed} 个无归属词库的单词`);
        orphanNotice = pr.removed;
      }
    } catch (e) {
      console.warn('[词忆] 孤儿单词清理失败', e);
    }
    ensureDailyTasks(S.db, S.date);
    closePlanIfDone(S.db, S.date);

    // 在线词典（可关闭）
    S.remote = new RemoteDictionary({ enabled: S.settings.dict_online_enabled !== '0' });
    S.dictService = new DictionaryService({ local: S.dict, remote: S.remote });

    step(100, '就绪');
    await new Promise((r) => setTimeout(r, 120));

    document.getElementById('boot').classList.add('hide');
    document.getElementById('app').hidden = false;

    // 路由
    document.querySelectorAll('.tab').forEach((t) => {
      t.addEventListener('click', () => navigate(t.dataset.route));
    });
    document.getElementById('themeBtn').addEventListener('click', cycleTheme);
    window.addEventListener('hashchange', () => navigate(routeFromHash(), true));

    navigate(routeFromHash(), true);
    if (orphanNotice > 0) {
      toast(`已清理 ${orphanNotice} 个不属于任何词库的残留单词`, 'info', 3600);
    }
    console.log(`[词忆] 启动完成 ${Date.now() - t0}ms，词典 ${S.dict.size} 词`);
  } catch (e) {
    console.error(e);
    bootText.textContent = '启动失败：' + (e.message || e);
    bootText.style.color = 'var(--bad)';
    bootBar.style.background = 'var(--bad)';
  }
}

// 离开页面时立刻落盘
window.addEventListener('pagehide', () => { if (S.db) { try { S.db.flush(); } catch (e) {} } });
window.addEventListener('beforeunload', () => { if (S.db) { try { S.db.flush(); } catch (e) {} } });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && S.db) {
    try { S.db.flush(); } catch (e) {}
  }
});

/* 测试钩子：便于在无浏览器环境下做端到端冒烟（对正常使用无影响） */
window.__APP__ = {
  S, navigate, render, startSession, nextQuestion, submitAnswer,
  importPasted, runTranslationCheck, getScreen: () => document.getElementById('screen'),
};

boot();
