import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { JOBS, planForEvent, selectJobs } from './select-jobs.mjs';

function expectJobs(plan, expected) {
  assert.deepEqual(Object.keys(plan.jobs).sort(), [...JOBS].sort());
  for (const job of JOBS) {
    assert.equal(plan.jobs[job], expected.includes(job), `${job}: ${plan.reason}`);
  }
  assert.equal(typeof plan.reason, 'string');
  assert.ok(plan.reason.length > 0);
}

const modified = (...paths) => paths.map((path) => ({ status: 'M', path }));

async function withRepository(run) {
  const cwd = await mkdtemp(join(tmpdir(), 'dambi-ci-selection-'));
  const git = (...args) => execFileSync('git', [
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args,
  ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = async (path, contents = 'fixture\n') => {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), contents);
  };
  const commit = (message) => {
    git('add', '--all');
    git('commit', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '--initial-branch=main');
    git('config', 'user.name', 'CI selection test');
    git('config', 'user.email', 'ci-selection@example.invalid');
    await run({ cwd, git, write, commit });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test('ordinary Markdown edits skip builds, but deleted or replaced documents fail safe', () => {
  expectJobs(selectJobs([]), []);
  expectJobs(selectJobs([
    { status: 'A', path: 'docs/adapter-plan.md' },
    { status: 'M', path: 'packages/core/README.md' },
  ]), []);
  for (const status of ['D', 'T']) {
    expectJobs(selectJobs([{ status, path: 'docs/required-contract.md' }]), JOBS);
  }
});

test('independent product changes select their consumers and combine across areas', () => {
  expectJobs(selectJobs(modified('packages/core/src/runtime/cache.ts')), ['core']);
  expectJobs(selectJobs(modified('registry-api/src/routes/decoders.ts')), ['registry-api']);
  expectJobs(selectJobs(modified('browser-extension/src/background.ts')), ['wasm', 'extension']);
  expectJobs(selectJobs(modified(
    'packages/core/src/runtime/cache.ts',
    'registry-api/src/routes/decoders.ts',
    'browser-extension/src/background.ts',
    'docs/release.md',
  )), ['core', 'registry-api', 'wasm', 'extension']);
});

test('server edits stay scoped except the handler consumed by extension catalog validation', () => {
  expectJobs(selectJobs(modified('crates/policy-server/db/src/lib.rs')), ['rust-server']);
  expectJobs(selectJobs(modified('crates/policy-server/server/src/handler.rs')),
    ['rust-server', 'wasm', 'extension']);
  expectJobs(selectJobs(modified(
    'crates/policy-server/server/src/handler.rs',
    'packages/core/src/index.ts',
  )), ['rust-server', 'wasm', 'extension', 'core']);
});

test('shared code, build inputs, CI configuration and unknown paths force the full matrix', () => {
  const paths = [
    '.github/workflows/ci.yml', '.github/README.md', 'scripts/ci/select-jobs.mjs',
    '.gitleaks.toml', '.gitleaksignore',
    'Cargo.toml', 'Cargo.lock', 'package.json', 'package-lock.json', 'yarn.lock',
    'pnpm-lock.yaml', 'rust-toolchain.toml',
    'packages/core/package.json', 'registry-api/pnpm-lock.yaml',
    'crates/policy-server/server/Cargo.toml',
    'crates/asset-model/action/src/lib.rs', 'Registry/decoder.json',
    'scripts/sdk/verify-isolated.mjs', 'fixtures/sdk/contract.json',
    'policies/day1.cedar', 'contracts/core-v1/schema.json', 'new-component/source.ts',
    // Illustrative future paths: no component is assumed to exist yet.
    'packages/scam-detector/src/index.ts', 'onchain/contracts/Registry.sol',
    'infra/registry-node/compose.yml',
  ];
  for (const path of paths) {
    expectJobs(selectJobs(modified('packages/core/src/index.ts', path)), JOBS);
  }
});

test('manual, unsupported, missing, invalid and unavailable Git context never skip checks', async () => {
  await withRepository(async ({ cwd, commit }) => {
    const head = commit('initial');
    const missing = 'f'.repeat(40);
    const cases = [
      ['workflow_dispatch', {}],
      ['schedule', {}],
      ['push', {}],
      ['push', { before: '0'.repeat(40), after: head }],
      ['push', { before: head, after: '--help' }],
      ['push', { before: missing, after: head }],
      ['push', { before: head, after: head, forced: true }],
      ['pull_request', {}],
      ['pull_request', { pull_request: { base: { sha: head }, head: { sha: missing } } }],
    ];
    for (const [name, event] of cases) {
      expectJobs(await planForEvent(name, event, { cwd }), JOBS);
    }
    expectJobs(await planForEvent('push', { before: head, after: head }, { cwd }), []);
  });
});

test('Git push selection preserves both sides of renames, unusual filenames and document deletions', async () => {
  await withRepository(async ({ cwd, git, write, commit }) => {
    await write('registry-api/src/original.ts');
    await write('docs/required.md');
    const before = commit('initial files');
    await mkdir(join(cwd, 'packages/core/src'), { recursive: true });
    git('mv', 'registry-api/src/original.ts', 'packages/core/src/renamed\nentry.ts');
    const after = commit('move code between independently tested products');
    expectJobs(await planForEvent('push', { before, after }, { cwd }), ['registry-api', 'core']);
    git('rm', 'docs/required.md');
    const deleted = commit('remove required document');
    expectJobs(await planForEvent('push', { before: after, after: deleted }, { cwd }), JOBS);
  });
});

test('PR selection uses its merge base so unrelated target branch changes do not widen the scope', async () => {
  await withRepository(async ({ cwd, git, write, commit }) => {
    commit('common ancestor');
    git('checkout', '-b', 'feature');
    await write('packages/core/src/cache.ts');
    const head = commit('core change');
    git('checkout', 'main');
    await write('crates/asset-model/action/src/lib.rs');
    const base = commit('unrelated main change');
    const event = { pull_request: { base: { sha: base }, head: { sha: head }, labels: [] } };
    expectJobs(await planForEvent('pull_request', event, { cwd }), ['core']);
  });
});

test('PR full-CI labels override path selection and malformed label metadata fails safe', async () => {
  await withRepository(async ({ cwd, write, commit }) => {
    const base = commit('initial');
    await write('packages/core/src/cache.ts');
    const head = commit('core change');
    const request = { base: { sha: base }, head: { sha: head } };
    const cases = [
      ['synchronize', [], ['core']],
      ['labeled', [{ name: 'enhancement' }], ['core']],
      ['labeled', [{ name: 'enhancement' }, { name: 'ci:full' }], JOBS],
      ['synchronize', [{ name: 'ci:full' }], JOBS],
      ['unlabeled', [], ['core']],
    ];
    for (const [action, labels, expected] of cases) {
      expectJobs(await planForEvent('pull_request', {
        action, pull_request: { ...request, labels },
      }, { cwd }), expected);
    }
    expectJobs(await planForEvent('pull_request', { pull_request: request }, { cwd }), JOBS);
    for (const labels of [null, 'ci:full', [null], [{}], [{ name: 42 }], [{ name: 'ci:full' }, { name: null }]]) {
      expectJobs(await planForEvent('pull_request', {
        pull_request: { ...request, labels },
      }, { cwd }), JOBS);
    }
  });
});

test('changes after the first 300 files are included in the Git diff', async () => {
  await withRepository(async ({ cwd, write, commit }) => {
    const before = commit('initial');
    for (let i = 0; i < 305; i += 1) {
      await write(`docs/reference-${String(i).padStart(3, '0')}.md`);
    }
    await write('packages/core/src/last-change.ts');
    const after = commit('large documentation update with a runtime change');
    expectJobs(await planForEvent('push', { before, after }, { cwd }), ['core']);
  });
});
