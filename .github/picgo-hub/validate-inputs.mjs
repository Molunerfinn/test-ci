import process from 'node:process';
import { pathToFileURL } from 'node:url';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const BASE_SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const ZERO_SHA = '0'.repeat(40);
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;

// The workflow kinds this repository runs for PicGo/picgo-hub and the source event each one accepts.
export const WORKFLOW_KINDS = ['preview', 'cleanup', 'deploy'];
export const DEPLOY_BRANCHES = ['main', 'production'];

export class InputValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputValidationError';
  }
}

function reject(message) {
  throw new InputValidationError(message);
}

export function isSafeBranchName(name) {
  return (
    typeof name === 'string' &&
    BRANCH_PATTERN.test(name) &&
    !name.includes('..') &&
    !name.includes('//') &&
    !name.includes('@{') &&
    !name.endsWith('/') &&
    !name.endsWith('.') &&
    !name.endsWith('.lock')
  );
}

export function validateInputs(input) {
  if (!WORKFLOW_KINDS.includes(input.kind)) reject(`kind must be one of ${WORKFLOW_KINDS.join(', ')}.`);
  if (!UUID_PATTERN.test(input.requestId ?? '')) reject('request_id must be a UUID.');
  if (!['pull_request', 'push'].includes(input.eventName)) reject('event_name must be pull_request or push.');
  if (!HEAD_SHA_PATTERN.test(input.headSha ?? '') || input.headSha === ZERO_SHA) {
    reject('head_sha must be a non-zero, 40-character lowercase commit SHA.');
  }
  if (!BASE_SHA_PATTERN.test(input.baseSha ?? '')) reject('base_sha must be a 40-character commit SHA.');
  if (!isSafeBranchName(input.targetBranch)) reject('target_branch must be a safe Git branch name.');
  if (!['true', 'false'].includes(input.forcePages)) reject('force_pages must be true or false.');

  if (input.eventName === 'pull_request') {
    if (!/^[1-9][0-9]{0,9}$/u.test(input.prNumber ?? '')) reject('pr_number must be a positive integer for a pull request.');
    if (!isSafeBranchName(input.headRef)) reject('head_ref must be a safe Git branch name for a pull request.');
  } else {
    if (input.prNumber !== '0') reject('pr_number must be 0 for a push.');
    if (input.forcePages !== 'false') reject('force_pages must be false for a push.');
    // A push may forward its own branch or nothing as head_ref; anything else must still be a safe name.
    if (input.headRef !== '' && !isSafeBranchName(input.headRef)) reject('head_ref must be empty or a safe Git branch name.');
  }

  if (input.kind === 'deploy') {
    if (input.eventName !== 'push') reject('the deploy workflow only accepts push events.');
    if (!DEPLOY_BRANCHES.includes(input.targetBranch)) {
      reject(`target_branch for the deploy workflow must be one of ${DEPLOY_BRANCHES.join(', ')}.`);
    }
  } else if (input.eventName !== 'pull_request') {
    reject(`the ${input.kind} workflow only accepts pull_request events.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    validateInputs({
      kind: process.env.WORKFLOW_KIND ?? '',
      requestId: process.env.REQUEST_ID ?? '',
      eventName: process.env.EVENT_NAME ?? '',
      headSha: process.env.HEAD_SHA ?? '',
      baseSha: process.env.BASE_SHA ?? '',
      targetBranch: process.env.TARGET_BRANCH ?? '',
      prNumber: process.env.PR_NUMBER ?? '',
      headRef: process.env.HEAD_REF ?? '',
      forcePages: process.env.FORCE_PAGES ?? '',
    });
  } catch (error) {
    if (!(error instanceof InputValidationError)) throw error;
    console.error(`::error::Invalid CI dispatch: ${error.message}`);
    process.exitCode = 1;
  }
}
