// Last-resort process handlers for the server. One process serves every player's game, camera
// (Presage) session and the PEARL market, so a single stray promise rejection (say an RPC 429
// deep inside a library) must not take all of them down. Each source we know of is fixed where
// it starts (rpc-guard.mjs); this only keeps the next unknown one from becoming an outage.
//
//   unhandledRejection  logged on one line, the process keeps running. A programming error
//                       (TypeError, ReferenceError, ...) is logged loudly, with its stack.
//   uncaughtException   left to Node's default: print the stack and exit 1 (systemd restarts us).
//                       After a synchronous throw the process state is unknown, so running on
//                       would be worse than a restart.

const PROGRAMMING = [TypeError, ReferenceError, RangeError, SyntaxError];

/** { bug, line, stack }: one line for the log, and whether it looks like a bug in our code. */
export function describeRejection(reason) {
  const bug = PROGRAMMING.some((T) => reason instanceof T);
  const name = reason instanceof Error ? reason.name : typeof reason;
  const message = String(reason?.message ?? reason).split('\n')[0].slice(0, 200);
  const where = reason instanceof Error ? (reason.stack ?? '').split('\n').slice(1, 2).join('').trim() : '';
  return { bug, line: `${name}: ${message}${where ? ` (${where})` : ''}`, stack: reason?.stack ?? null };
}

let installed = false;

/** Install once per process. `log` is the server's logger; bugs also go to stderr with the stack. */
export function guardProcess({ log = console.log, error = console.error } = {}) {
  if (installed) return;
  installed = true;
  process.on('unhandledRejection', (reason) => {
    const d = describeRejection(reason);
    if (d.bug) {
      error(`[process] BUG: unhandled rejection (kept running): ${d.line}`);
      if (d.stack) error(d.stack);
    } else {
      log(`[process] unhandled rejection (kept running): ${d.line}`);
    }
  });
}
