/**
 * db.js —— SQLite(WASM) 封装
 *
 * 用 sql.js（真正的 SQLite 编译成 WebAssembly），不是模拟 ORM。
 * Node 测试与浏览器/APK 使用同一套代码，只是加载 wasm 的方式不同。
 */

import { DDL, INDEXES_EXTRA, DEFAULT_SETTINGS } from './schema.js';

/**
 * 包装一个 sql.js Database
 * @param {object} SQL      已初始化的 sql.js 模块
 * @param {Uint8Array|null} data  已有数据库二进制
 * @param {(bytes:Uint8Array)=>void} [persist] 写盘回调（浏览器用）
 */
export function createDB(SQL, data = null, persist = null) {
  const raw = data ? new SQL.Database(data) : new SQL.Database();
  raw.run('PRAGMA foreign_keys = ON;');

  let dirty = false;
  let saveTimer = null;

  function markDirty() {
    dirty = true;
    if (!persist) return;
    // 合并写盘：避免每次答题都序列化整个数据库
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      flush();
    }, 400);
  }

  /** 立刻把数据库序列化写出去（重要操作后调用） */
  function flush() {
    if (!dirty || !persist) return;
    dirty = false;
    try {
      persist(raw.export());
    } catch (e) {
      console.error('[db] 持久化失败', e);
    }
  }

  /* ---------------- 低层查询 ---------------- */

  function all(sql, params = []) {
    const stmt = raw.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  function get(sql, params = []) {
    const rows = all(sql, params);
    return rows.length ? rows[0] : null;
  }

  function run(sql, params = []) {
    const stmt = raw.prepare(sql);
    try {
      stmt.bind(params);
      stmt.step();
    } finally {
      stmt.free();
    }
    const changes = raw.getRowsModified();
    const idRow = get('SELECT last_insert_rowid() AS id');
    markDirty();
    return { changes, lastId: idRow ? idRow.id : null };
  }

  function exec(sql) {
    raw.run(sql);
    markDirty();
  }

  /* ---------------- 事务 ---------------- */

  let txDepth = 0;

  /**
   * 在事务里执行 fn。嵌套调用使用 SAVEPOINT，保证内层失败不会污染外层。
   * fn 抛错 -> 回滚并继续抛出。
   */
  function transaction(fn) {
    const isOuter = txDepth === 0;
    const sp = 'sp_' + txDepth;
    raw.run(isOuter ? 'BEGIN IMMEDIATE;' : `SAVEPOINT ${sp};`);
    txDepth++;
    try {
      const result = fn();
      txDepth--;
      raw.run(isOuter ? 'COMMIT;' : `RELEASE ${sp};`);
      markDirty();
      return result;
    } catch (err) {
      txDepth--;
      try {
        raw.run(isOuter ? 'ROLLBACK;' : `ROLLBACK TO ${sp}; RELEASE ${sp};`);
      } catch (e) {
        /* 回滚本身失败就忽略，保留原始错误 */
      }
      throw err;
    }
  }

  /* ---------------- 初始化 ---------------- */

  function migrate() {
    transaction(() => {
      for (const sql of DDL) raw.run(sql);
      for (const sql of INDEXES_EXTRA) raw.run(sql);
      // 记录 schema 版本，便于将来升级
      raw.run(`INSERT INTO app_settings(key,value) VALUES('schema_version','1')
               ON CONFLICT(key) DO NOTHING;`);
      for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        raw.run(`INSERT INTO app_settings(key,value) VALUES(?,?)
                 ON CONFLICT(key) DO NOTHING;`, [k, v]);
      }
    });
  }

  function tableNames() {
    return all(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .map((r) => r.name);
  }

  function close() {
    flush();
    raw.close();
  }

  return {
    raw, all, get, run, exec, transaction,
    migrate, tableNames, flush, close, markDirty,
    toBinary: () => raw.export(),
    get size() { return raw.export().length; },
  };
}

/**
 * Node 环境加载 sql.js（UMD 包，用 createRequire）
 * @param {string} vendorDir  相对或绝对路径，内部会 resolve 成绝对路径
 */
export async function loadSqlJsNode(vendorDir) {
  const { createRequire } = await import('node:module');
  const path = await import('node:path');
  // 注意：createRequire 的基准是本文件，相对路径必须显式按 cwd 解析
  const dir = path.resolve(process.cwd(), vendorDir);
  const require = createRequire(import.meta.url);
  const initSqlJs = require(path.join(dir, 'sql-wasm.js'));
  return initSqlJs({
    locateFile: (f) => path.join(dir, f),
  });
}
