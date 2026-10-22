import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Zero-dependency structural checks: the workflows are written in a fixed, indentation-based layout, so plain text
// scanning is enough to pin down the contract picgo-bot relies on.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (file) => readFileSync(path.join(root, file), 'utf8');

const EXPECTED_INPUTS = ['request_id', 'event_name', 'head_sha', 'base_sha', 'target_branch', 'pr_number', 'head_ref', 'force_pages'];


const WORKFLOWS = [
  {
    file: '.github/workflows/picgo-hub-preview.yml',
    prefix: 'picgo-hub-preview',
    kind: 'preview',
    jobs: [
      'Test Worker',
      'Setup Neon Branch && Hyperdrive',
      'Deploy PR Worker (API)',
      'Detect Pages Changes',
      'Deploy Portal Preview',
      'Deploy Admin Preview',
      'Comment Preview Result',
    ],
    concurrencyGroup: 'picgo-hub-preview-${{ inputs.pr_number }}',
    cancelInProgress: 'true',
  },
  {
    file: '.github/workflows/picgo-hub-cleanup.yml',
    prefix: 'picgo-hub-cleanup',
    kind: 'cleanup',
    jobs: [
      'Cleanup Custom Hostnames',
      'Cleanup Neon Branch',
      'Cleanup Hyperdrive',
      'Cleanup Worker',
      'Cleanup DNS Records',
      'Comment Cleanup Result',
    ],
    concurrencyGroup: 'picgo-hub-cleanup-${{ inputs.pr_number }}',
    cancelInProgress: 'false',
  },
  {
    file: '.github/workflows/picgo-hub-deploy.yml',
    prefix: 'picgo-hub-deploy',
    kind: 'deploy',
    jobs: ['Test Worker', 'Deploy Worker (API)', 'Deploy Portal (Pages - cloud.picgo.app)', 'Deploy Admin (Pages - admin.picgo.app)'],
    concurrencyGroup: 'picgo-hub-deploy-${{ inputs.target_branch }}',
    cancelInProgress: 'false',
  },
];

/** Asserts the pattern does not occur, reporting only the offending match instead of the whole file. */
function refute(text, pattern) {
  const match = pattern.exec(text);
  assert.equal(match, null, match ? `unexpected ${JSON.stringify(match[0])} near ${JSON.stringify(text.slice(Math.max(0, match.index - 80), match.index + 80))}` : '');
}

const indentOf = (line) => line.length - line.trimStart().length;

/** Returns the lines of the block that starts after `headerIndex` and is indented deeper than `headerIndent`. */
function blockAfter(lines, headerIndex, headerIndent) {
  const block = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== '' && indentOf(line) <= headerIndent) break;
    block.push(line);
  }
  return block;
}

/** Top-level section body, e.g. topLevel(text, 'env'). */
function topLevel(text, key) {
  const lines = text.split('\n');
  const index = lines.findIndex((line) => line === `${key}:` || line.startsWith(`${key}: `));
  if (index === -1) return null;
  return { header: lines[index], body: blockAfter(lines, index, 0) };
}

/** Splits the `jobs:` section into { id, lines } entries. */
function jobsOf(text) {
  const { body } = topLevel(text, 'jobs');
  const jobs = [];
  for (const line of body) {
    const match = /^ {2}([A-Za-z0-9_-]+):$/u.exec(line);
    if (match) jobs.push({ id: match[1], lines: [] });
    else if (jobs.length) jobs.at(-1).lines.push(line);
  }
  return jobs;
}

/** Splits a job into its steps (each beginning with `      - `). */
function stepsOf(job) {
  const lines = job.lines;
  const start = lines.findIndex((line) => line === '    steps:');
  assert.notEqual(start, -1, `job ${job.id} has no steps`);
  const steps = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {6}- /u.test(line)) steps.push([line]);
    else if (steps.length) steps.at(-1).push(line);
  }
  return steps.map((step) => step.join('\n'));
}

/** Every `run:` script body in the text (block scalars and inline values). */
function runScripts(text) {
  const lines = text.split('\n');
  const scripts = [];
  lines.forEach((line, index) => {
    const match = /^(\s*)(?:- )?run: ?(.*)$/u.exec(line);
    if (!match) return;
    const value = match[2];
    if (/^[|>][-+]?$/u.test(value)) scripts.push(blockAfter(lines, index, indentOf(line)).join('\n'));
    else scripts.push(value);
  });
  return scripts;
}

for (const workflow of WORKFLOWS) {
  const text = read(workflow.file);

  test(`${workflow.prefix}: only workflow_dispatch with the eight required string inputs`, () => {
    const on = topLevel(text, 'on');
    assert.ok(on, 'missing on:');
    const triggers = on.body.filter((line) => /^ {2}[a-z_]+:/u.test(line)).map((line) => line.trim().replace(/:.*$/u, ''));
    assert.deepEqual(triggers, ['workflow_dispatch']);

    const onText = on.body.join('\n');
    const inputs = [...onText.matchAll(/^ {6}([a-z_]+):$/gmu)].map((match) => match[1]);
    assert.deepEqual(inputs, EXPECTED_INPUTS);
    for (const input of EXPECTED_INPUTS) {
      assert.match(onText, new RegExp(`^ {6}${input}:\\n(?: {8}.+\\n)*? {8}required: true\\n {8}type: string$`, 'mu'), input);
    }
  });

  test(`${workflow.prefix}: run-name carries the request id`, () => {
    assert.match(text, new RegExp(`^run-name: ${workflow.prefix}:\\$\\{\\{ inputs\\.request_id \\}\\}$`, 'mu'));
  });

  test(`${workflow.prefix}: job names match the check-run contract exactly`, () => {
    const names = jobsOf(text).map((job) => {
      const nameLine = job.lines.find((line) => /^ {4}name: /u.test(line));
      assert.ok(nameLine, `job ${job.id} has no name`);
      return nameLine.replace(/^ {4}name: /u, '');
    });
    assert.deepEqual(names, workflow.jobs);
  });


  test(`${workflow.prefix}: concurrency is keyed and cancellable as agreed`, () => {
    const concurrency = topLevel(text, 'concurrency');
    assert.ok(concurrency, 'missing concurrency');
    assert.deepEqual(concurrency.body.filter((line) => line.trim()), [
      `  group: ${workflow.concurrencyGroup}`,
      `  cancel-in-progress: ${workflow.cancelInProgress}`,
    ]);
    for (const job of jobsOf(text)) {
      assert.ok(!job.lines.some((line) => /^ {4}concurrency:/u.test(line)), `job ${job.id} overrides concurrency`);
    }
  });

  test(`${workflow.prefix}: read-only workflow token and no GITHUB_TOKEN use`, () => {
    const permissions = topLevel(text, 'permissions');
    assert.deepEqual(permissions.body.filter((line) => line.trim()), ['  contents: read']);
    for (const job of jobsOf(text)) {
      assert.ok(!job.lines.some((line) => /^ {4}permissions:/u.test(line)), `job ${job.id} widens permissions`);
    }
    refute(text, /GITHUB_TOKEN|github\.token/u);
  });

  test(`${workflow.prefix}: no expression is interpolated into a run script`, () => {
    for (const script of runScripts(text)) {
      assert.doesNotMatch(script, /\$\{\{/u, script.slice(0, 200));
    }
  });

  test(`${workflow.prefix}: secrets never appear in workflow- or job-level env`, () => {
    const env = topLevel(text, 'env');
    if (env) assert.doesNotMatch(env.body.join('\n'), /secrets\.|vars\./u);
    for (const job of jobsOf(text)) {
      const lines = job.lines;
      lines.forEach((line, index) => {
        if (line === '    env:') assert.doesNotMatch(blockAfter(lines, index, 4).join('\n'), /secrets\./u, `job ${job.id}`);
      });
    }
  });

  test(`${workflow.prefix}: installs and tests run without secrets`, () => {
    for (const job of jobsOf(text)) {
      for (const step of stepsOf(job)) {
        if (/pnpm install|pnpm test|node --test/u.test(step)) assert.doesNotMatch(step, /secrets\./u, step);
      }
    }
  });

  test(`${workflow.prefix}: every job checks out trusted helpers, then validates the dispatch`, () => {
    for (const job of jobsOf(text)) {
      const [helpers, validate] = stepsOf(job);
      assert.match(helpers, /uses: actions\/checkout@v5\n {8}with:\n {10}persist-credentials: false\n {10}sparse-checkout: \.github\/picgo-hub$/mu, job.id);
      assert.match(validate, /uses: \.\/\.github\/picgo-hub\/checkout\n/u, job.id);
      assert.match(validate, new RegExp(`^ {10}kind: ${workflow.kind}$`, 'mu'), job.id);
      for (const input of EXPECTED_INPUTS) {
        const key = input.replaceAll('_', '-');
        assert.match(validate, new RegExp(`^ {10}${key}: \\$\\{\\{ inputs\\.${input} \\}\\}$`, 'mu'), `${job.id} ${key}`);
      }
      if (!/checkout: 'false'/u.test(validate)) {
        assert.match(validate, /app-id: \$\{\{ vars\.PICGO_APP_ID \}\}/u);
        assert.match(validate, /private-key: \$\{\{ secrets\.PICGO_APP_PRIVATE_KEY \}\}/u);
      }
    }
  });

  test(`${workflow.prefix}: source paths point into hub/ and legacy contexts are gone`, () => {
    refute(text, /github\.(sha|head_ref|ref_name|event)\b|github\.repository\b(?!\s*\}\}\/actions\/runs)/u);
    refute(text, /upload-artifact|head -50|pull_request_target/u);
    refute(text, /working-directory: (?!hub(\/|$))/mu);
    refute(text, /workingDirectory: (?!'?hub(\/|'|$))/mu);
    for (const match of text.matchAll(/pages deploy (\S+)/gu)) assert.match(match[1], /^packages\/(portal|admin)\/dist$/u);
    for (const match of text.matchAll(/cache: pnpm\n(\s+)(\S.*)/gu)) assert.equal(match[2], 'cache-dependency-path: hub/pnpm-lock.yaml');
    const checkouts = text.match(/uses: actions\/checkout@/gu) ?? [];
    const persisted = text.match(/persist-credentials: false/gu) ?? [];
    assert.equal(checkouts.length, persisted.length);
  });
}

test('preview: detect diffs inside hub/ against the dispatched head', () => {
  const text = read('.github/workflows/picgo-hub-preview.yml');
  const detect = jobsOf(text).find((job) => job.id === 'detect-pages-changes');
  const steps = stepsOf(detect).join('\n');
  assert.match(steps, /fetch-depth: '0'/u);
  assert.match(steps, /working-directory: hub\n(?:.*\n)*? {10}HEAD_SHA: \$\{\{ inputs\.head_sha \}\}\n {10}FORCE_PAGES: \$\{\{ inputs\.force_pages \}\}/u);
  assert.match(steps, /run: node \.github\/scripts\/preview-pages\.mjs detect$/mu);
  refute(text, /labeled/u);
  for (const match of text.matchAll(/command: pages deploy .*$/gmu)) assert.match(match[0], /--commit-hash=\$\{\{ inputs\.head_sha \}\}$/u);
});

test('deploy: branch-dependent values come from target_branch', () => {
  const text = read('.github/workflows/picgo-hub-deploy.yml');
  assert.match(text, /DATABASE_URL: \$\{\{ inputs\.target_branch == 'production' && secrets\.DATABASE_URL_PROD \|\| secrets\.DATABASE_URL_STAGING \}\}/u);
  assert.match(text, /--branch=\$\{\{ inputs\.target_branch \}\}/u);
});

test('deploy: Edge staging deploys from main inside the existing Worker job', () => {
  const text = read('.github/workflows/picgo-hub-deploy.yml');
  const deploy = jobsOf(text).find((job) => job.id === 'deploy-worker');
  const steps = stepsOf(deploy);
  const edge = steps.find((step) => /name: Deploy Edge Worker \(staging\)/u.test(step));

  assert.ok(edge, 'missing Edge staging deploy step');
  assert.match(edge, /if: inputs\.target_branch == 'main' && steps\.edge-config\.outputs\.present == 'true'/u);
  assert.match(edge, /workingDirectory: 'hub\/packages\/worker'/u);
  assert.match(edge, /command: deploy -c wrangler\.edge\.jsonc/u);
  assert.match(text, /name: Detect Edge Worker config/u);
  assert.match(text, /sed -i .*wrangler\.jsonc/u);
  assert.match(text, /sed -i .*wrangler\.edge\.jsonc/u);
});

test('deploy: Edge production deploys from production inside the existing Worker job', () => {
  const text = read('.github/workflows/picgo-hub-deploy.yml');
  const deploy = jobsOf(text).find((job) => job.id === 'deploy-worker');
  const steps = stepsOf(deploy);
  const edge = steps.find((step) => /name: Deploy Edge Worker \(production\)/u.test(step));

  assert.ok(edge, 'missing Edge production deploy step');
  assert.match(edge, /if: inputs\.target_branch == 'production' && steps\.edge-config\.outputs\.present == 'true'/u);
  assert.match(edge, /workingDirectory: 'hub\/packages\/worker'/u);
  assert.match(edge, /command: deploy -c wrangler\.edge\.jsonc/u);
  assert.match(edge, /environment: production/u);
});

test('preview: deploys the PR Edge Worker and targets it from preview custom domains', () => {
  const text = read('.github/workflows/picgo-hub-preview.yml');
  const deploy = jobsOf(text).find((job) => job.id === 'deploy-worker');
  const steps = stepsOf(deploy);
  const edge = steps.find((step) => /name: Deploy Edge Worker \(PR\)/u.test(step));

  assert.ok(edge, 'missing Edge PR deploy step');
  assert.match(edge, /if: steps\.edge-config\.outputs\.present == 'true'/u);
  assert.match(edge, /workingDirectory: 'hub\/packages\/worker'/u);
  assert.match(edge, /command: deploy -c wrangler\.edge\.jsonc/u);
  assert.match(text, /EDGE_WORKER_NAME: picgo-edge-pr-\$\{\{ inputs\.pr_number \}\}/u);
  assert.match(text, /CUSTOM_DOMAIN_ROUTE_TARGET.*EDGE_WORKER_NAME/u);
  assert.match(text, /name: Prepare Edge Worker config for PR/u);
  assert.match(text, /Refusing to deploy an unexpected Edge Worker name/u);
  assert.doesNotMatch(edge, /environment: production/u);
});

test('cleanup: removes the PR Edge Worker and its media route', () => {
  const text = read('.github/workflows/picgo-hub-cleanup.yml');
  assert.match(text, /EDGE_WORKER_NAME: picgo-edge-pr-\$\{\{ inputs\.pr_number \}\}/u);
  assert.match(text, /for script in "\$WORKER_NAME" "\$EDGE_WORKER_NAME"; do/u);
  assert.match(text, /MEDIA_ROUTE_PATTERN="\$\{HOSTNAME\}\/m\/\*"/u);
  assert.match(text, /Refusing to delete an unexpected Worker name/u);
  assert.match(text, /Refusing to delete an unexpected Edge Worker name/u);
});

test('PR comments use a pull-requests:write App token and match picgo-bot comments', () => {
  for (const file of ['.github/workflows/picgo-hub-preview.yml', '.github/workflows/picgo-hub-cleanup.yml']) {
    const text = read(file);
    assert.match(text, /uses: actions\/create-github-app-token@v2\n {8}with:\n {10}app-id: \$\{\{ vars\.PICGO_APP_ID \}\}\n {10}private-key: \$\{\{ secrets\.PICGO_APP_PRIVATE_KEY \}\}\n {10}owner: PicGo\n {10}repositories: picgo-hub\n {10}permission-pull-requests: write$/mu);
    assert.match(text, /GH_TOKEN: \$\{\{ steps\.comment-token\.outputs\.token \}\}/u);
    assert.match(text, /REPO: PicGo\/picgo-hub$/mu);
    assert.match(text, /select\(\.user\.login == "picgo-bot\[bot\]"\)/u);
    assert.doesNotMatch(text, /github-actions\[bot\]/u);
    assert.match(text, /RUN_URL: \$\{\{ github\.server_url \}\}\/\$\{\{ github\.repository \}\}\/actions\/runs\/\$\{\{ github\.run_id \}\}/u);
  }
});

test('checkout action validates first and revokes its read-only token', () => {
  const text = read('.github/picgo-hub/checkout/action.yml');
  const steps = text.split(/^ {4}- name: /mu).slice(1);
  assert.match(steps[0], /^Validate dispatch inputs\n/u);
  assert.match(steps[0], /node "\$GITHUB_ACTION_PATH\/\.\.\/validate-inputs\.mjs"/u);
  assert.match(text, /owner: PicGo\n {8}repositories: picgo-hub\n {8}permission-contents: read\n {8}skip-token-revoke: true/u);
  assert.match(text, /repository: PicGo\/picgo-hub\n {8}ref: \$\{\{ inputs\.head-sha \}\}/u);
  assert.match(text, /persist-credentials: false/u);
  assert.match(steps.at(-1), /^Revoke the source token\n {6}if: \$\{\{ always\(\) && steps\.app-token\.outputs\.token != '' \}\}/u);
  for (const script of runScripts(text)) assert.doesNotMatch(script, /\$\{\{/u);
});
