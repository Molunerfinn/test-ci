import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Guards that picgo-hub's own tests used to apply to its deploy-preview.yml and deploy.yml. Those workflows now live here,
// so the checks moved with them: picgo-hub can no longer read these files from its tests.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const preview = read('.github/workflows/picgo-hub-preview.yml');
const deploy = read('.github/workflows/picgo-hub-deploy.yml');

function job(source, id) {
  const body = source.split(`\n  ${id}:\n`)[1]?.split(/\n {2}[a-z][a-z-]*:\n/)[0];
  assert.ok(body, `missing job ${id}`);
  return body;
}

test('every deployment tests Castaly config, then pure tests before local tests', () => {
  for (const source of [preview, deploy]) {
    const testJob = job(source, 'test-worker');
    assert.match(testJob, /pnpm test:castaly-config/);
    assert.match(testJob, /^\s+(?:run: )?pnpm test:pure\s*$/m);
    assert.ok(testJob.indexOf('pnpm test:pure') < testJob.indexOf('pnpm test:local'));
  }
  assert.match(job(preview, 'test-worker'), /node --test \.\.\/\.\.\/\.github\/scripts\/preview-pages\.test\.mjs/);
});

test('deployments never read or register Castaly production secrets', () => {
  assert.doesNotMatch(deploy, /CASTALY_.*SECRET|check-deploy/);
  assert.doesNotMatch(deploy, /castaly-production\.mjs register|CASTALY_PRODUCTION_OAUTH_CLIENT_SECRET/);
  assert.doesNotMatch(preview, /CASTALY_|castaly-preview\.mjs/);
  assert.doesNotMatch(preview, /temporary test bypass/i);
});

test('preview deploys are gated on tests and use recovery-aware Pages detection', () => {
  assert.match(job(preview, 'detect-pages-changes'), /node \.github\/scripts\/preview-pages\.mjs detect/);
  for (const id of ['deploy-worker', 'deploy-portal', 'deploy-admin']) {
    assert.match(job(preview, id), /needs\.test-worker\.result == 'success'/, `${id} must wait for passing tests`);
  }
  for (const id of ['deploy-portal', 'deploy-admin']) {
    assert.match(job(preview, id), /needs\.detect-pages-changes\.result == 'success'/);
  }
  for (const id of ['deploy-worker', 'deploy-portal', 'deploy-admin']) {
    assert.match(job(deploy, id), /needs: test-worker/, `${id} must wait for passing tests`);
  }
});

test('preview comment notes distinguish actual success, failure, blocked jobs and verified reuse', () => {
  const fn = preview.match(/ {10}deployment_note\(\) \{[\s\S]*?\n {10}\}/)?.[0];
  assert.ok(fn);
  const note = (result, changed, detect = 'success') => execFileSync('bash', ['-c', `${fn}\nDETECT_RESULT="$3"; deployment_note "$1" "$2"`, '--', result, changed, detect], { encoding: 'utf8' }).trim();
  assert.equal(note('success', 'true'), 'Updated in this run');
  assert.equal(note('failure', 'true'), 'Not updated (failure)');
  assert.equal(note('skipped', 'true'), 'Not updated (skipped)');
  assert.equal(note('skipped', 'false', 'failure'), 'Not updated (skipped)');
  assert.equal(note('skipped', 'false'), 'Reused verified existing preview (no build-input changes)');
});
