import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { InputValidationError, isSafeBranchName, validateInputs } from '../validate-inputs.mjs';

const scriptPath = fileURLToPath(new URL('../validate-inputs.mjs', import.meta.url));
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

const pullRequest = {
  kind: 'preview',
  requestId: '123e4567-e89b-42d3-a456-426614174000',
  eventName: 'pull_request',
  headSha: HEAD,
  baseSha: BASE,
  targetBranch: 'main',
  prNumber: '42',
  headRef: 'feat/new-thing',
  forcePages: 'false',
};

const push = {
  ...pullRequest,
  kind: 'deploy',
  eventName: 'push',
  baseSha: '0'.repeat(40),
  prNumber: '0',
  headRef: 'main',
};

function rejects(input, pattern) {
  assert.throws(() => validateInputs(input), (error) => error instanceof InputValidationError && pattern.test(error.message));
}

test('accepts valid preview, cleanup, and deploy dispatches', () => {
  validateInputs(pullRequest);
  validateInputs({ ...pullRequest, forcePages: 'true' });
  validateInputs({ ...pullRequest, kind: 'cleanup' });
  validateInputs(push);
  validateInputs({ ...push, targetBranch: 'production', headRef: 'production' });
  validateInputs({ ...push, headRef: '' });
});

test('rejects malformed request ids and event names', () => {
  rejects({ ...pullRequest, requestId: 'not-a-uuid' }, /request_id/u);
  rejects({ ...pullRequest, requestId: '' }, /request_id/u);
  rejects({ ...pullRequest, eventName: 'pull_request_target' }, /event_name/u);
  rejects({ ...pullRequest, kind: 'other' }, /kind/u);
});

test('rejects malformed commit SHAs', () => {
  rejects({ ...pullRequest, headSha: 'A'.repeat(40) }, /head_sha/u);
  rejects({ ...pullRequest, headSha: 'a'.repeat(39) }, /head_sha/u);
  rejects({ ...pullRequest, headSha: '0'.repeat(40) }, /head_sha/u);
  rejects({ ...pullRequest, headSha: `${'a'.repeat(39)};` }, /head_sha/u);
  rejects({ ...pullRequest, baseSha: 'g'.repeat(40) }, /base_sha/u);
});

test('rejects unsafe branch names', () => {
  for (const name of ['', '-x', 'a..b', 'a//b', 'a@{1}', 'a/', 'a.', 'a.lock', 'a b', 'a;rm', '$(id)', 'a`b`', 'a\nb']) {
    assert.equal(isSafeBranchName(name), false, JSON.stringify(name));
  }
  rejects({ ...pullRequest, targetBranch: 'main;id' }, /target_branch/u);
  rejects({ ...pullRequest, headRef: '$(curl evil)' }, /head_ref/u);
  rejects({ ...pullRequest, headRef: '' }, /head_ref/u);
  rejects({ ...push, headRef: 'x y' }, /head_ref/u);
});

test('enforces pr_number and force_pages per event', () => {
  rejects({ ...pullRequest, prNumber: '0' }, /pr_number/u);
  rejects({ ...pullRequest, prNumber: '01' }, /pr_number/u);
  rejects({ ...pullRequest, prNumber: '1 ' }, /pr_number/u);
  rejects({ ...pullRequest, forcePages: 'yes' }, /force_pages/u);
  rejects({ ...push, prNumber: '3' }, /pr_number/u);
  rejects({ ...push, forcePages: 'true' }, /force_pages/u);
});

test('binds each workflow kind to its event and branches', () => {
  rejects({ ...push, kind: 'preview' }, /preview workflow only accepts pull_request/u);
  rejects({ ...push, kind: 'cleanup' }, /cleanup workflow only accepts pull_request/u);
  rejects({ ...pullRequest, kind: 'deploy' }, /deploy workflow only accepts push/u);
  rejects({ ...push, targetBranch: 'develop', headRef: 'develop' }, /main, production/u);
});

test('the CLI reads the environment and fails with an annotation', () => {
  const env = {
    PATH: process.env.PATH,
    WORKFLOW_KIND: 'preview',
    REQUEST_ID: pullRequest.requestId,
    EVENT_NAME: 'pull_request',
    HEAD_SHA: HEAD,
    BASE_SHA: BASE,
    TARGET_BRANCH: 'main',
    PR_NUMBER: '42',
    HEAD_REF: 'feat/x',
    FORCE_PAGES: 'false',
  };
  const ok = spawnSync(process.execPath, [scriptPath], { env, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);

  const bad = spawnSync(process.execPath, [scriptPath], { env: { ...env, PR_NUMBER: '0' }, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /::error::Invalid CI dispatch: pr_number/u);
});
