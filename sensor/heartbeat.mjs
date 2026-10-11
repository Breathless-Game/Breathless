// WebSocket liveness. A game whose laptop slept or whose network dropped leaves a
// half-open socket the OS may not notice for minutes. Its session keeps the live
// Presage slot (MAX_LIVE_SESSIONS) all that time, so the same player's reconnect is
// told "busy". Each sweep pings every socket; one that has not answered the
// previous ping (or sent anything since) is terminated, which fires 'close' and
// frees its slot within two sweeps.

/** Call once per new socket. */
export function watchAlive(ws) {
  ws.isAlive = true;
  const alive = () => {
    ws.isAlive = true;
  };
  ws.on('pong', alive);
  ws.on('message', alive);
}

/** Terminates the sockets that stayed silent since the last sweep, pings the rest. Returns how many it dropped. */
export function sweepDead(clients) {
  let dropped = 0;
  for (const ws of clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      dropped++;
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
  return dropped;
}
