// An in-memory stand-in for @upstash/redis (automaticDeserialization off): only the commands the
// market store (market-store.mjs) and scripts/import-to-redis.mjs use, with the same return
// shapes. Every command yields to the event loop first, so two "instances" sharing one fake
// interleave like two serverless functions sharing one database; each command is then atomic.
//
// EVAL runs a JS twin of each of the store's Lua scripts, picked by the script's exact text, so a
// script the fake doesn't know fails loudly instead of passing silently.

import { CAS_SCRIPT, INCR_SCRIPT, SERIAL_SCRIPT } from '../market-store.mjs';

const tick = () => new Promise((r) => setImmediate(r));

export function createFakeRedis({ now = () => Date.now(), jitter = true } = {}) {
  const data = new Map(); // key -> { type: 'string' | 'hash' | 'zset', value, expiresAt }
  const calls = [];

  const live = (key) => {
    const e = data.get(key);
    if (e && e.expiresAt <= now()) {
      data.delete(key);
      return null;
    }
    return e ?? null;
  };
  const typed = (key, type) => {
    const e = live(key);
    if (e && e.type !== type) throw new Error(`WRONGTYPE ${key} is a ${e.type}`);
    return e;
  };
  const str = (key) => typed(key, 'string')?.value ?? null;
  const putStr = (key, value, px) => data.set(key, { type: 'string', value: String(value), expiresAt: px ? now() + Number(px) : Infinity });

  // Some commands wait one more turn, so concurrent callers' commands interleave in varied orders.
  let n = 0;
  async function step(name) {
    calls.push(name);
    await tick();
    if (jitter && n++ % 3 === 0) await tick();
  }

  const scripts = new Map([
    [
      CAS_SCRIPT,
      ([key], [hasExpected, expected, hasNext, next, ttl]) => {
        const cur = str(key);
        if (hasExpected === '1' ? cur !== expected : cur !== null) return 0;
        if (hasNext === '1') putStr(key, next, ttl || undefined);
        else data.delete(key);
        return 1;
      },
    ],
    [
      INCR_SCRIPT,
      ([key], [ttl]) => {
        const v = Number(str(key) ?? 0) + 1;
        const e = live(key);
        if (e) e.value = String(v);
        else putStr(key, v, v === 1 && ttl ? ttl : undefined);
        return v;
      },
    ],
    [
      SERIAL_SCRIPT,
      ([hashKey, lastKey], [field, max]) => {
        const h = typed(hashKey, 'hash')?.value;
        if (h?.has(field)) return Number(h.get(field));
        const last = Number(str(lastKey) ?? 0);
        if (last >= Number(max)) return -1;
        const next = last + 1;
        putStr(lastKey, next);
        if (!h) data.set(hashKey, { type: 'hash', value: new Map([[field, String(next)]]), expiresAt: Infinity });
        else h.set(field, String(next));
        return next;
      },
    ],
  ]);

  return {
    data,
    calls,
    async get(key) {
      await step('get');
      return str(key);
    },
    async set(key, value, opts = {}) {
      await step('set');
      if (opts.nx && live(key)) return null;
      putStr(key, value, opts.px);
      return 'OK';
    },
    async del(...keys) {
      await step('del');
      let count = 0;
      for (const k of keys.flat()) if (live(k) && data.delete(k)) count++;
      return count;
    },
    async mget(...keys) {
      await step('mget');
      return keys.flat().map((k) => str(k));
    },
    async hget(key, field) {
      await step('hget');
      return typed(key, 'hash')?.value.get(field) ?? null;
    },
    async hset(key, obj) {
      await step('hset');
      let e = typed(key, 'hash');
      if (!e) data.set(key, (e = { type: 'hash', value: new Map(), expiresAt: Infinity }));
      let added = 0;
      for (const [f, v] of Object.entries(obj)) {
        if (!e.value.has(f)) added++;
        e.value.set(f, String(v));
      }
      return added;
    },
    async hsetnx(key, field, value) {
      await step('hsetnx');
      let e = typed(key, 'hash');
      if (!e) data.set(key, (e = { type: 'hash', value: new Map(), expiresAt: Infinity }));
      if (e.value.has(field)) return 0;
      e.value.set(field, String(value));
      return 1;
    },
    async hgetall(key) {
      await step('hgetall');
      const e = typed(key, 'hash');
      return e && e.value.size ? Object.fromEntries(e.value) : null;
    },
    async zadd(key, { score, member }) {
      await step('zadd');
      let e = typed(key, 'zset');
      if (!e) data.set(key, (e = { type: 'zset', value: new Map(), expiresAt: Infinity }));
      const added = e.value.has(member) ? 0 : 1;
      e.value.set(String(member), Number(score));
      return added;
    },
    async zrange(key, min, max, opts = {}) {
      await step('zrange');
      if (!opts.byScore) throw new Error('fake zrange: only byScore');
      const lo = min === '-inf' ? -Infinity : Number(min);
      const hi = max === '+inf' ? Infinity : Number(max);
      const e = typed(key, 'zset');
      return [...(e?.value ?? [])]
        .filter(([, s]) => s >= lo && s <= hi)
        .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
        .map(([m]) => m);
    },
    /** One pass over everything (cursor "0" back): MATCH supports `*` only, as the scripts use it. */
    async scan(_cursor, { match = '*' } = {}) {
      await step('scan');
      const re = new RegExp(`^${match.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      return ['0', [...data.keys()].filter((k) => live(k) && re.test(k))];
    },
    async eval(script, keys, args) {
      await step('eval');
      const fn = scripts.get(script);
      if (!fn) throw new Error('fake redis: unknown script');
      return fn(keys, args.map(String));
    },
  };
}
