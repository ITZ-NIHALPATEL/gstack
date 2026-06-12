/**
 * gstack-detach — the SIGTERM-survival guard.
 *
 * Proves the wrapper runs its command in a DIFFERENT process group than the
 * caller (so a group SIGTERM from the harness can't reach it) and that the
 * command outlives the launching shell (returns immediately, completes later).
 * This is the regression guard that keeps the eval-killer dead.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const DETACH = path.join(ROOT, 'bin', 'gstack-detach');

function ownPgid(): string {
  const r = spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf-8' });
  return (r.stdout || '').trim();
}

describe('gstack-detach', () => {
  test('returns immediately and the command keeps running detached', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-detach-'));
    const log = path.join(dir, 'run.log');
    const marker = path.join(dir, 'marker');
    const pgidFile = path.join(dir, 'child.pgid');
    try {
      const started = Date.now();
      // Child records its own pgid, sleeps past the launcher's return, then writes
      // a marker — proving it ran to completion independently of this shell.
      const cmd = `ps -o pgid= -p $$ | tr -d ' ' > '${pgidFile}'; sleep 2; echo ok > '${marker}'`;
      const r = spawnSync(DETACH, [log, '--', 'bash', '-c', cmd], { encoding: 'utf-8', timeout: 10000 });
      const elapsed = Date.now() - started;

      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/PID \d+ {2}LOG /);
      // Non-blocking: the launcher returns well before the child's 2s sleep ends.
      expect(elapsed).toBeLessThan(1500);

      // Poll for the marker — the detached child finishes after the launcher exited.
      let survived = false;
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        if (fs.existsSync(marker)) { survived = true; break; }
        spawnSync('sleep', ['0.2']);
      }
      expect(survived).toBe(true);

      // Detached: the child's process group differs from ours, so a group SIGTERM
      // aimed at this process can't reach it.
      const childPgid = fs.readFileSync(pgidFile, 'utf-8').trim();
      expect(childPgid).not.toBe('');
      expect(childPgid).not.toBe(ownPgid());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  test('rejects missing command (exit 2)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-detach-'));
    try {
      const r = spawnSync(DETACH, [path.join(dir, 'x.log')], { encoding: 'utf-8' });
      expect(r.status).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
