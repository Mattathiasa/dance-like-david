// Small JSON-on-disk helpers: atomic writes and a per-file lock so concurrent requests can't interleave.
import fsp from 'node:fs/promises';

const locks = new Map();

export async function readJson(p, fallback = null) {
  try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return fallback; }
}

export async function writeJson(p, value) {
  const tmp = `${p}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value));
  await fsp.rename(tmp, p); // atomic on the same filesystem: readers never see half a file
}

export function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

/** Read-modify-write under a lock. fn may mutate the value or return a new one. */
export function updateJson(p, fallback, fn) {
  return withLock(p, async () => {
    const value = await readJson(p, structuredClone(fallback));
    const out = (await fn(value)) ?? value;
    await writeJson(p, out);
    return out;
  });
}

export const httpError = (status, message) => Object.assign(new Error(message), { status });
