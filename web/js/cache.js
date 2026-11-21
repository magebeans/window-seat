// Offline cache management, page side.
//
// The service worker precaches the small app shell at install. The big files (basemap parts, POI
// chunks, fonts) are downloaded from here, right after the worker activates, because:
//   * iOS may kill a service worker during a long install event, and a failed install throws away
//     the worker and leaves nothing usable; a page-driven loop is resumable file by file;
//   * the page can hold a wake lock and show progress while it runs.
// Every file is checked against the sha256 in precache.json before it is stored.

const DATA = 'ws-data';
const shellName = (v) => `ws-shell-${v}`;
const MB = 1e6;

export class OfflineCache {
  constructor(onChange) {
    this.onChange = onChange;
    this.manifest = null;
    this.state = { phase: 'checking', doneBytes: 0, totalBytes: 0, doneFiles: 0, totalFiles: 0, errors: [], missing: [] };
    this.running = false;
  }

  emit(patch) { Object.assign(this.state, patch); this.onChange?.(this.state); }

  async loadManifest() {
    // Prefer the copy the active worker installed with (matches the shell we are running).
    const r = await fetch('precache.json');
    if (!r.ok) throw new Error(`precache.json: HTTP ${r.status}`);
    this.manifest = await r.json();
    const total = this.manifest.entries.reduce((s, e) => s + e.size, 0);
    this.emit({ totalBytes: total, totalFiles: this.manifest.entries.length, version: this.manifest.version });
    return this.manifest;
  }

  async status() {
    if (!this.manifest) await this.loadManifest();
    const shell = await caches.open(shellName(this.manifest.version));
    const data = await caches.open(DATA);
    const have = new Set();
    for (const c of [shell, data]) for (const req of await c.keys()) have.add(new URL(req.url).pathname);
    const base = new URL('./', location.href).pathname;
    let doneBytes = 0, doneFiles = 0;
    const missing = [];
    for (const e of this.manifest.entries) {
      if (have.has(base + e.url)) { doneBytes += e.size; doneFiles++; } else missing.push(e);
    }
    const phase = missing.length === 0 ? 'ready' : 'incomplete';
    this.emit({ phase, doneBytes, doneFiles, missing: missing.map((e) => e.url) });
    return { missing, phase };
  }

  async download({ concurrency = 3 } = {}) {
    if (this.running) return;
    this.running = true;
    try {
      const { missing } = await this.status();
      if (!missing.length) return;
      this.emit({ phase: 'downloading', errors: [] });
      const shell = await caches.open(shellName(this.manifest.version));
      const data = await caches.open(DATA);
      const queue = [...missing];
      const errors = [];
      const one = async (e) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const r = await fetch(e.url, { cache: 'no-store', headers: { 'x-ws-download': '1' } });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const buf = await r.arrayBuffer();
            if (buf.byteLength !== e.size) throw new Error(`size ${buf.byteLength} != ${e.size}`);
            const hash = await sha256hex(buf);
            if (hash !== e.sha256) throw new Error('sha256 mismatch');
            const type = r.headers.get('Content-Type') || 'application/octet-stream';
            const res = new Response(buf, { headers: { 'Content-Type': type, 'Content-Length': String(e.size), 'X-SHA256': hash } });
            await (e.group === 'shell' ? shell : data).put(new URL(e.url, location.href).href, res);
            this.emit({ doneBytes: this.state.doneBytes + e.size, doneFiles: this.state.doneFiles + 1 });
            return;
          } catch (err) {
            if (attempt === 2) { errors.push(`${decodeURIComponent(e.url)}: ${err.message}`); this.emit({ errors: [...errors] }); }
            else await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, async () => { while (queue.length) await one(queue.shift()); }));
      const st = await this.status();
      if (st.phase === 'ready') await this.prune();
    } catch (err) {
      this.emit({ phase: 'error', errors: [...this.state.errors, String(err.message || err)] });
    } finally {
      this.running = false;
    }
  }

  /** Remove data-cache entries no longer in the manifest (old basemap builds etc.). */
  async prune() {
    const data = await caches.open(DATA);
    const keep = new Set(this.manifest.entries.map((e) => new URL(e.url, location.href).href));
    let n = 0;
    for (const req of await data.keys()) if (!keep.has(req.url)) { await data.delete(req); n++; }
    return n;
  }

  /** Full check: every entry present, right size, right hash header; deep = re-hash the bytes. */
  async verify({ deep = false, onProgress } = {}) {
    if (!this.manifest) await this.loadManifest();
    const shell = await caches.open(shellName(this.manifest.version));
    const data = await caches.open(DATA);
    const bad = [];
    let i = 0;
    for (const e of this.manifest.entries) {
      const url = new URL(e.url, location.href).href;
      const r = (await shell.match(url)) || (await data.match(url));
      if (!r) bad.push(`${e.url}: missing`);
      else if (deep) {
        const buf = await r.arrayBuffer();
        if (buf.byteLength !== e.size) bad.push(`${e.url}: size ${buf.byteLength} != ${e.size}`);
        else if ((await sha256hex(buf)) !== e.sha256) bad.push(`${e.url}: hash mismatch`);
      } else {
        const h = r.headers.get('X-SHA256');
        if (h && h !== e.sha256) bad.push(`${e.url}: stale (hash differs)`);
      }
      if (++i % 25 === 0) onProgress?.(i, this.manifest.entries.length);
    }
    return bad;
  }
}

export async function sha256hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function persistStorage() {
  const out = { persisted: null, quota: null, usage: null };
  if (navigator.storage?.persist) {
    try { out.persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist()); } catch { out.persisted = false; }
  }
  if (navigator.storage?.estimate) {
    try { const e = await navigator.storage.estimate(); out.quota = e.quota; out.usage = e.usage; } catch { /* ignore */ }
  }
  return out;
}

export const fmtMB = (b) => `${(b / MB).toFixed(b < 10 * MB ? 1 : 0)} MB`;
