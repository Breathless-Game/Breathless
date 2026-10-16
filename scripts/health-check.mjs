// Hourly health check of production (.github/workflows/health.yml). Public endpoints and the
// public devnet RPC only: no secrets. When something is wrong it keeps ONE open GitHub issue,
// labelled `health` and assigned to the maintainer, up to date; when everything recovers it
// comments and closes it. See deploy/VERCEL.md ("Health check") for what is checked and why.
//
//   node scripts/health-check.mjs [--dry-run] [--site=https://breathless.gotclass.xyz]
//                                 [--rpc=https://api.devnet.solana.com]
//
// --dry-run (the default outside GitHub Actions) only prints: it never reads or touches issues.
// Exits 0 whatever the checks find (a red hourly run would email on every failure on top of the
// issue); non-zero only when the script itself breaks.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SITE = 'https://breathless.gotclass.xyz';
export const RPC = 'https://api.devnet.solana.com';
export const ASSIGNEE = 'Bowen1314';
export const LABEL = 'health';

/** SPL Token (not Token-2022): sensor/market-server-mode.mjs TOKEN_PROGRAM. */
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
/** Metaplex Core: the fish collection is a Core collection account. */
export const CORE_PROGRAM = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';

/**
 * Market wallet SOL. Below FUNDED_SOL (sensor/market-server-mode.mjs) /api/market/info reports
 * funded:false and the mint/collection setup refuses to run; a sale costs the market ~0.002 SOL
 * (the seller's PEARL account rent, first sale only) plus a few 5,000-lamport fees (payout, burn,
 * refund). WARN is the server's own AIRDROP_BELOW_SOL: below it the server asks for an airdrop,
 * which only runs at start-up and usually fails on devnet, so it needs topping up by hand.
 */
export const SOL_CRITICAL = 0.02;
export const SOL_WARN = 0.5;

/** Venomous Hammerhead Shark #0026: its URI as minted on chain (Core asset Ssdxi63TqUAqACmRarRbquieZJeRVZwQ9TvooqNuDTt). */
export const FISH_META_PATH =
  '/api/nft/meta/v2/26/43d2622c/epic/126-134-83-17.92/bulky-292-82-56-121-0/The%20Trench/Venomous%20Hammerhead%20Shark.json';
export const FISH_NAME = 'Venomous Hammerhead Shark #0026';

/** With an open issue and the same failing set, comment again at most this often. */
export const QUIET_MS = 6 * 60 * 60_000;

const TIMEOUT_MS = 20_000; // a cold start of the function takes a few seconds; the RPC can be slow
const BACKOFF_MS = [2_000, 6_000];
const FUNDED_RETRY_MS = 16_000; // past the server's 15 s balance cache
const MARKER = /<!-- health-check failing="([^"]*)" -->/;

// ---------------------------------------------------------------------------------------------
// Pure logic

/** Worth another try within this run: no answer at all, rate-limited, or a server error. */
export const retryable = (res) => !res || res.status === 429 || res.status >= 500;

/**
 * fetch with up to `tries` attempts (backoff between them) and a timeout per attempt. Returns the
 * last Response, or throws the last network/timeout error. A definitive answer (any 2xx/3xx/4xx
 * but 429) is returned at once.
 */
export async function fetchRetry(fetchImpl, url, init = {}, { tries = 3, timeoutMs = TIMEOUT_MS, backoff = BACKOFF_MS, sleep = defaultSleep } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    if (i > 0) await sleep(backoff[Math.min(i - 1, backoff.length - 1)]);
    try {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (!retryable(res) || i === tries - 1) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STATUS_ORDER = { fail: 0, warn: 1, 'rpc-unreachable': 2, skipped: 3, ok: 4 };

/**
 * results: [{ name, status: 'ok'|'warn'|'fail'|'rpc-unreachable'|'skipped', detail }]
 * failing: "name:status" for every warn/fail, sorted (the issue's identity). rpc-unreachable and
 * skipped are shown but never open an issue on their own: the public devnet RPC 429s routinely,
 * and a skipped check's cause (the market info) is already failing.
 */
export function evaluate(results) {
  const failing = results.filter((r) => r.status === 'fail' || r.status === 'warn').map((r) => `${r.name}:${r.status}`).sort();
  const unknown = results.filter((r) => r.status === 'rpc-unreachable' || r.status === 'skipped').map((r) => `${r.name}:${r.status}`).sort();
  const ok = failing.length === 0;
  const summary = ok
    ? unknown.length
      ? `OK, but not checked: ${unknown.join(', ')}`
      : `All ${results.length} checks OK`
    : `Failing: ${failing.join(', ')}`;
  return { ok, failing, unknown, summary };
}

/** The failing set recorded in an issue body or comment by this script, or null when there is none. */
export function readMarker(text) {
  const m = MARKER.exec(text ?? '');
  return m ? (m[1] ? m[1].split(',') : []) : null;
}
export const marker = (failing) => `<!-- health-check failing="${failing.join(',')}" -->`;

/**
 * What to do with the health issue.
 *   issue: null (none open) | { number, lastFailing: string[] | null, lastAt: ms }  the newest marker
 *   failing: the current failing set (evaluate().failing); now: ms
 * -> { action: 'open' | 'comment' | 'close' | 'none', reason }
 */
export function decideIssueAction({ issue, failing, now, quietMs = QUIET_MS }) {
  if (!issue) return failing.length ? { action: 'open', reason: 'new failure' } : { action: 'none', reason: 'healthy' };
  if (!failing.length) return { action: 'close', reason: 'recovered' };
  if (!issue.lastFailing || !sameSet(issue.lastFailing, failing)) return { action: 'comment', reason: 'failing set changed' };
  if (!(now - issue.lastAt < quietMs)) return { action: 'comment', reason: 'still failing (reminder)' };
  return { action: 'none', reason: 'unchanged, commented recently' };
}
const sameSet = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/** The newest marker in an issue ({ body, createdAt, comments: [{ body, createdAt }] }, gh's JSON). */
export function issueState(issue) {
  let last = { lastFailing: readMarker(issue.body), lastAt: Date.parse(issue.createdAt) };
  for (const c of issue.comments ?? []) {
    const f = readMarker(c.body);
    if (f) last = { lastFailing: f, lastAt: Date.parse(c.createdAt) };
  }
  return { number: issue.number, ...last };
}

export function textTable(results) {
  const rows = [['check', 'status', 'detail'], ...results.map((r) => [r.name, r.status.toUpperCase(), r.detail])];
  const w = [0, 1].map((i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => `${r[0].padEnd(w[0])}  ${r[1].padEnd(w[1])}  ${r[2]}`).join('\n');
}

const ICON = { ok: '✅', warn: '⚠️', fail: '❌', 'rpc-unreachable': '❔', skipped: '⏭️' };
export function markdownTable(results) {
  const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return ['| Check | Status | Detail |', '| --- | --- | --- |', ...results.map((r) => `| \`${r.name}\` | ${ICON[r.status] ?? ''} ${r.status} | ${esc(r.detail)} |`)].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Checks (fetch injected so the tests need no network)

const sol = (lamports) => (lamports / 1e9).toFixed(4);
const ok = (name, detail) => ({ name, status: 'ok', detail });
const bad = (name, detail, status = 'fail') => ({ name, status, detail });

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`not JSON: ${text.slice(0, 80)}`);
  }
}

/** Runs one check; a thrown error is a failure of that check (with the reason as detail). */
async function guard(name, fn) {
  try {
    return await fn();
  } catch (e) {
    return bad(name, e?.name === 'TimeoutError' ? 'timed out (3 tries)' : String(e?.message ?? e).slice(0, 200));
  }
}

export async function runChecks({ fetch: f = globalThis.fetch, site = SITE, rpc = RPC, retry = {} } = {}) {
  const get = (path, init) => fetchRetry(f, new URL(path, site), init, retry);
  const results = [];

  results.push(
    await guard('site', async () => {
      const res = await get('/');
      const body = await res.text();
      if (res.status !== 200) return bad('site', `GET / -> ${res.status}`);
      if (!/text\/html/.test(res.headers.get('content-type') ?? '')) return bad('site', `content-type ${res.headers.get('content-type')}`);
      if (!body.includes('id="scene"') || !body.includes('Breathless')) return bad('site', 'HTML is not the game (no <canvas id="scene"> / title)');
      return ok('site', 'GET / 200, game HTML');
    }),
  );

  let info = null;
  results.push(
    await guard('market-info', async () => {
      // info() swallows its own RPC error as funded:false (market-server-mode.mjs), so one devnet
      // 429 on the server's side looks unfunded: ask again (its balance cache lasts 15 s) first.
      for (let attempt = 0; ; attempt++) {
        const res = await get('/api/market/info');
        if (res.status !== 200) return bad('market-info', `GET /api/market/info -> ${res.status}: ${(await res.text()).slice(0, 120)}`);
        const j = await readJson(res);
        const missing = ['market', 'pearlMint', 'fishCollection', 'tokenProgram'].filter((k) => typeof j[k] !== 'string' || !j[k]);
        if (j.mode !== 'server') return bad('market-info', `mode is ${JSON.stringify(j.mode)}, not "server"`);
        if (missing.length) return bad('market-info', `missing ${missing.join(', ')}`);
        info = j;
        if (j.funded === true) return ok('market-info', `mode server, funded, market ${j.market.slice(0, 6)}…`);
        if (attempt >= 2) return bad('market-info', `funded is ${JSON.stringify(j.funded)} 3 times: the server sees < ${SOL_CRITICAL} SOL or cannot reach its RPC (see market-sol)`);
        await (retry.sleep ?? defaultSleep)(FUNDED_RETRY_MS);
      }
    }),
  );

  // One RPC request for all three accounts: fewer chances of a 429.
  const chain = ['market-sol', 'pearl-mint', 'fish-collection'];
  if (!info) {
    for (const name of chain) results.push(bad(name, 'needs the market info', 'skipped'));
  } else {
    let accounts = null;
    let rpcError = '';
    try {
      const res = await fetchRetry(
        f,
        rpc,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [[info.market, info.pearlMint, info.fishCollection], { encoding: 'jsonParsed', commitment: 'confirmed' }] }),
        },
        retry,
      );
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const j = await readJson(res);
      if (!Array.isArray(j?.result?.value)) throw new Error(j?.error?.message ?? 'no result');
      accounts = j.result.value;
    } catch (e) {
      rpcError = e?.name === 'TimeoutError' ? 'timed out' : String(e?.message ?? e).slice(0, 120);
    }
    if (!accounts) {
      for (const name of chain) results.push(bad(name, `devnet RPC unavailable after 3 tries (${rpcError})`, 'rpc-unreachable'));
    } else {
      const [market, mint, coll] = accounts;
      const lamports = market?.lamports ?? 0;
      const s = lamports / 1e9;
      results.push(
        s < SOL_CRITICAL
          ? bad('market-sol', `${sol(lamports)} SOL < ${SOL_CRITICAL} (critical: sales stop). Fund ${info.market}`)
          : s < SOL_WARN
            ? bad('market-sol', `${sol(lamports)} SOL < ${SOL_WARN} (warn: top up ${info.market})`, 'warn')
            : ok('market-sol', `${sol(lamports)} SOL (warn < ${SOL_WARN}, critical < ${SOL_CRITICAL})`),
      );

      const m = mint?.data?.parsed;
      results.push(
        !mint
          ? bad('pearl-mint', `PEARL mint ${info.pearlMint} does not exist`)
          : mint.owner !== TOKEN_PROGRAM || info.tokenProgram !== TOKEN_PROGRAM
            ? bad('pearl-mint', `mint owned by ${mint.owner}, info says ${info.tokenProgram}; expected ${TOKEN_PROGRAM}`)
            : m?.type !== 'mint' || !m.info?.isInitialized
              ? bad('pearl-mint', 'account is not an initialized mint')
              : m.info.mintAuthority !== info.market
                ? bad('pearl-mint', `mint authority is ${m.info.mintAuthority}, not the market: payouts cannot mint`)
                : ok('pearl-mint', `market is mint authority; supply ${Number(m.info.supply).toLocaleString('en-US')} PEARL`),
      );

      results.push(
        !coll
          ? bad('fish-collection', `collection ${info.fishCollection} does not exist`)
          : coll.owner !== CORE_PROGRAM
            ? bad('fish-collection', `owned by ${coll.owner}, not Metaplex Core`)
            : ok('fish-collection', 'Core collection exists'),
      );
    }
  }

  let image = null;
  results.push(
    await guard('nft-meta', async () => {
      const res = await get(FISH_META_PATH);
      if (res.status !== 200) return bad('nft-meta', `-> ${res.status}`);
      if (!/^application\/json/.test(res.headers.get('content-type') ?? '')) return bad('nft-meta', `content-type ${res.headers.get('content-type')}`);
      const j = await readJson(res);
      if (j.name !== FISH_NAME) return bad('nft-meta', `name is ${JSON.stringify(j.name)}`);
      if (typeof j.image !== 'string') return bad('nft-meta', 'no image URL');
      image = j.image;
      return ok('nft-meta', `${FISH_NAME} JSON 200`);
    }),
  );
  results.push(
    !image
      ? bad('nft-image', 'needs the metadata', 'skipped')
      : await guard('nft-image', async () => {
          const res = await fetchRetry(f, image, {}, retry); // as given, ?r=<renderer> included
          if (res.status !== 200) return bad('nft-image', `-> ${res.status}`);
          if (!/^image\/png/.test(res.headers.get('content-type') ?? '')) return bad('nft-image', `content-type ${res.headers.get('content-type')}`);
          const b = new Uint8Array(await res.arrayBuffer());
          if (b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return bad('nft-image', 'body is not a PNG');
          return ok('nft-image', `image/png, ${b.length.toLocaleString('en-US')} bytes`);
        }),
  );

  results.push(
    await guard('cron-route', async () => {
      const res = await get('/api/cron/sweep');
      await res.arrayBuffer();
      return res.status === 401 ? ok('cron-route', 'GET /api/cron/sweep without auth -> 401') : bad('cron-route', `expected 401, got ${res.status}`);
    }),
  );

  return results;
}

// ---------------------------------------------------------------------------------------------
// Issue I/O (gh CLI, GH_TOKEN from the workflow)

function gh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'inherit'] });
}

function report(results, verdict, { site }) {
  return [`**${verdict.summary}**`, '', markdownTable(results), '', `Checked ${new Date().toISOString()} against ${site}.`, marker(verdict.failing)].join('\n');
}

function findIssue(repo) {
  const list = JSON.parse(gh(['issue', 'list', '--repo', repo, '--label', LABEL, '--state', 'open', '--json', 'number,createdAt', '--limit', '20']));
  if (!list.length) return null;
  const oldest = list.sort((a, b) => a.number - b.number)[0];
  return issueState(JSON.parse(gh(['issue', 'view', String(oldest.number), '--repo', repo, '--json', 'number,body,createdAt,comments'])));
}

function applyAction(repo, action, issue, body, verdict) {
  if (action === 'open') {
    gh(['label', 'create', LABEL, '--repo', repo, '--color', 'D93F0B', '--description', 'Production health check (scripts/health-check.mjs)', '--force']);
    const title = `Production health check failing: ${verdict.failing.join(', ')}`.slice(0, 200);
    const full = `@${ASSIGNEE} the hourly health check found a problem.\n\n${body}`;
    try {
      return gh(['issue', 'create', '--repo', repo, '--title', title, '--label', LABEL, '--assignee', ASSIGNEE, '--body-file', '-'], full).trim();
    } catch {
      // Assigning can fail (e.g. not a collaborator); the @mention still notifies.
      return gh(['issue', 'create', '--repo', repo, '--title', title, '--label', LABEL, '--body-file', '-'], full).trim();
    }
  }
  if (action === 'comment') return gh(['issue', 'comment', String(issue.number), '--repo', repo, '--body-file', '-'], body).trim();
  if (action === 'close') {
    gh(['issue', 'comment', String(issue.number), '--repo', repo, '--body-file', '-'], `Recovered.\n\n${body}`);
    return gh(['issue', 'close', String(issue.number), '--repo', repo, '--reason', 'completed']).trim() || `closed #${issue.number}`;
  }
  return '';
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
  const site = args.site ?? SITE;
  const rpc = args.rpc ?? RPC;
  const dryRun = 'dry-run' in args ? args['dry-run'] !== 'false' : !process.env.GITHUB_ACTIONS;

  const results = await runChecks({ site, rpc });
  const verdict = evaluate(results);
  console.log(textTable(results));
  console.log(`\n${verdict.summary}`);

  const body = report(results, verdict, { site });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Production health\n\n${body}\n`);

  if (dryRun) {
    console.log(`\n[dry-run] issues untouched. With no open issue the action would be: ${decideIssueAction({ issue: null, failing: verdict.failing, now: Date.now() }).action}`);
    return;
  }
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY is not set (use --dry-run outside Actions)');
  const issue = findIssue(repo);
  const { action, reason } = decideIssueAction({ issue, failing: verdict.failing, now: Date.now() });
  console.log(`\nissue: ${issue ? `#${issue.number}` : 'none open'} -> ${action} (${reason})`);
  const out = applyAction(repo, action, issue, body, verdict);
  if (out) console.log(out);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`[health] ${e?.stack ?? e}`);
    process.exit(1);
  });
}
