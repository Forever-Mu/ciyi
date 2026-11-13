/**
 * platform.js —— 环境适配
 *
 * 同一份核心代码要跑在三个地方：Node(测试)、浏览器、Android WebView。
 * 这里把「读文件」「解压」「发请求」三件平台相关的事收拢起来。
 */

let _fflate = null;

/** 允许测试或宿主显式注入 fflate */
export function setFflate(f) {
  _fflate = f;
}

export async function getFflate() {
  if (_fflate) return _fflate;

  // 浏览器 / WebView：vendor/fflate.js 作为普通脚本引入后会挂到 window 上
  if (typeof globalThis !== 'undefined' && globalThis.fflate) {
    _fflate = globalThis.fflate;
    return _fflate;
  }

  // Node：vendor 目录声明为 commonjs，可以直接 require
  const { createRequire } = await import('node:module');
  const path = await import('node:path');
  const require = createRequire(import.meta.url);
  _fflate = require(path.resolve(process.cwd(), 'vendor', 'fflate.js'));
  return _fflate;
}

const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);

/**
 * 读取二进制资源
 * @param {string} src  Node 下是文件路径，浏览器下是 URL
 * @returns {Promise<Uint8Array>}
 */
export async function readBinary(src) {
  if (isNode) {
    const fs = await import('node:fs');
    return new Uint8Array(fs.readFileSync(src));
  }
  const res = await fetch(src, { cache: 'no-cache' });
  if (!res.ok) throw new Error('加载失败 HTTP ' + res.status + '：' + src);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * 带超时的 JSON 请求
 * @param {string} url
 * @param {{timeoutMs?:number, headers?:object}} opts
 * @returns {Promise<{ok:boolean, data?:any, status?:number, notFound?:boolean,
 *                    retryAfter?:number, error?:string, timeout?:boolean}>}
 */
export async function fetchJson(url, opts = {}) {
  const timeout = opts.timeoutMs || 12000;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: Object.assign({ Accept: 'application/json' }, opts.headers || {}),
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (res.status === 404) return { ok: false, notFound: true, status: 404 };
    if (!res.ok) {
      const retryAfter = Number(res.headers && res.headers.get && res.headers.get('Retry-After')) || 0;
      return { ok: false, status: res.status, retryAfter, error: 'HTTP ' + res.status };
    }
    const data = await res.json();
    return { ok: true, status: res.status, data };
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message)));
    return { ok: false, error: aborted ? '请求超时' : String(e.message || e), timeout: aborted };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 是否有网络能力（离线时应直接跳过远程查询） */
export function hasNetwork() {
  if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
    return navigator.onLine;
  }
  return true;
}

export { isNode };
