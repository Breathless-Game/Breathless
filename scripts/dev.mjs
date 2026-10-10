// Runs sensor + game together. Replaces `npm run sensor & npm run game`, which on
// Windows (cmd) runs the two sequentially, so the game never starts.
import { spawn } from 'node:child_process';

const isWin = process.platform === 'win32';
const tasks = [
  ['sensor', 'npm --prefix sensor start'],
  ['game', 'npm --prefix game run dev'],
];

const children = tasks.map(([name, command]) => {
  // npm is npm.cmd on Windows, which Node only spawns through a shell.
  const child = spawn(command, { stdio: 'inherit', shell: true });
  child.on('exit', (code) => {
    console.log(`[dev] ${name} exited (${code})`);
    shutdown(code ?? 0);
  });
  return child;
});

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    // child.kill() on Windows only kills the shell, not the node process under it.
    if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
  process.exitCode = code;
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
