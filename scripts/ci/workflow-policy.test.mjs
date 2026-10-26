import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const protection = JSON.parse(readFileSync(new URL('./main-protection.json', import.meta.url), 'utf8'));
const requiredNames = protection.required_status_checks.checks.map(({ context }) => context).sort();
const jobSource = workflow.slice(workflow.indexOf('\njobs:\n'));
const jobs = [...jobSource.matchAll(/^  ([a-z][a-z0-9-]*):\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|$(?![\s\S]))/gm)]
  .map(([, id, body]) => ({ id, body, name: field(body, 'name', 4), condition: field(body, 'if', 4) }));
const concurrency = workflow.match(/^concurrency:\n([\s\S]*?)(?=^jobs:)/m)?.[1];
assert.ok(concurrency, 'the workflow must declare concurrency');

function field(source, key, indent) {
  const match = source.match(new RegExp(`^ {${indent}}${key}: (.+)$`, 'm'));
  assert.ok(match, `missing ${key} at indentation ${indent}`);
  return match[1];
}

function step(source, name) {
  const body = source.split(`      - name: ${name}\n`)[1];
  assert.ok(body, `missing step ${name}`);
  return body.split('\n      - ')[0];
}

// This intentionally handles only the expression subset used by this workflow:
// context paths, quoted strings, !/&&/||/==/!=, parentheses and three pure calls.
// It is not a general GitHub Actions expression or YAML interpreter. Unknown
// syntax fails so a workflow change cannot silently escape these assertions.
function evaluate(source, context) {
  const tokens = [];
  let remaining = source.trim();
  while (remaining) {
    const token = /^(?:'(?:[^']|'')*'|&&|\|\||==|!=|[!(),]|[A-Za-z_][A-Za-z0-9_.-]*)/.exec(remaining)?.[0];
    assert.ok(token, `unsupported workflow expression near ${remaining}`);
    tokens.push(token);
    remaining = remaining.slice(token.length).trimStart();
  }
  let cursor = 0;
  const peek = () => tokens[cursor];
  const take = () => tokens[cursor++];
  const expect = (token) => assert.equal(take(), token);
  const equal = (left, right) => typeof left === 'string' && typeof right === 'string'
    ? left.toLowerCase() === right.toLowerCase() : left === right;
  const functions = {
    always: () => true,
    cancelled: () => context.cancelled,
    format: (template, ...args) => template.replace(/\{(\d+)\}/g, (_, index) => String(args[index])),
  };
  function primary() {
    const token = take();
    assert.ok(token, 'expression ended before a value');
    if (token === '!') return !primary();
    if (token === '(') {
      const value = or();
      expect(')');
      return value;
    }
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    if (peek() === '(') {
      assert.ok(Object.hasOwn(functions, token), `unsupported expression function ${token}`);
      take();
      const args = [];
      if (peek() !== ')') {
        args.push(or());
        while (peek() === ',') { take(); args.push(or()); }
      }
      expect(')');
      return functions[token](...args);
    }
    assert.match(token, /^(?:github|needs)\./);
    // Missing context properties are empty strings in Actions expressions.
    return token.split('.').reduce((value, key) => value?.[key], context) ?? '';
  }
  function equality() {
    let value = primary();
    while (peek() === '==' || peek() === '!=') {
      const operator = take();
      const comparison = equal(value, primary());
      value = operator === '==' ? comparison : !comparison;
    }
    return value;
  }
  function and() {
    let value = equality();
    while (peek() === '&&') { take(); const right = equality(); value = value && right; }
    return value;
  }
  function or() {
    let value = and();
    while (peek() === '||') { take(); const right = and(); value = value || right; }
    return value;
  }
  const value = or();
  assert.equal(cursor, tokens.length, 'all workflow expression tokens must be consumed');
  return value;
}

function expression(value, context) {
  assert.ok(value.startsWith('${{ ') && value.endsWith(' }}'), 'expected one Actions expression');
  return evaluate(value.slice(4, -3), context);
}

function render(value, context) {
  return value.replace(/\$\{\{ ([\s\S]*?) \}\}/g, (_, body) => String(evaluate(body, context)));
}

function context(eventName = 'pull_request', event = {}, runId = 101) {
  const ref = eventName === 'pull_request' ? 'refs/pull/13/merge'
    : eventName === 'push' ? 'refs/heads/main' : 'refs/heads/feat/adapters';
  return {
    github: { event_name: eventName, event, workflow: 'ci', ref, run_id: runId },
    needs: {
      changes: { result: 'success', outputs: Object.fromEntries(jobs.map(({ id }) => [id, 'true'])) },
      wasm: { result: 'success' },
      core: { result: 'success' },
    },
    cancelled: false,
  };
}

const group = (value) => render(field(concurrency, 'group', 2), value);
const cancels = (value) => expression(field(concurrency, 'cancel-in-progress', 2), value);
const names = (value) => jobs.map(({ name }) => render(name, value));
const selected = (value) => jobs.filter(({ condition }) => expression(condition, value)).map(({ id }) => id).sort();

test('normal CI events keep all protected check names and the existing cancellation policy', () => {
  assert.equal(jobs.length, 9, 'all nine existing checks must remain covered');
  const events = [
    ...['opened', 'synchronize', 'reopened'].map((action) => context('pull_request', { action })),
    ...['labeled', 'unlabeled'].map((action) => context('pull_request', { action, label: { name: 'ci:full' } })),
    // Unknown or missing label metadata must retain normal CI, not silently skip.
    context('pull_request', { action: 'labeled' }),
    context('pull_request', { action: 'unlabeled', label: {} }),
    context('push'),
    context('workflow_dispatch'),
  ];
  for (const value of events) {
    assert.deepEqual(names(value).sort(), requiredNames);
    assert.deepEqual(selected(value), requiredNames);
    assert.equal(group(value), `ci-ci-${value.github.ref}`);
    assert.equal(cancels(value), value.github.ref !== 'refs/heads/main');
  }
});

test('unrelated labels cannot run builds, replace protected checks or cancel active CI', () => {
  const active = context('pull_request', { action: 'synchronize' });
  const activeGroup = group(active);
  const ignoredGroups = new Set();
  for (const action of ['labeled', 'unlabeled']) {
    for (const labels of [[], [{ name: 'ci:full' }]]) {
      for (const runId of [101, 102]) {
        const value = context('pull_request', {
          action, label: { name: 'enhancement' }, pull_request: { labels },
        }, runId);
        assert.deepEqual(selected(value), []);
        assert.equal(names(value).length, new Set(names(value)).size, 'ignored jobs retain distinct names');
        assert.ok(names(value).every((name) => !requiredNames.includes(name)), 'skipped checks cannot overwrite required contexts');
        assert.notEqual(group(value), activeGroup);
        assert.equal(cancels(value), false);
        ignoredGroups.add(group(value));
      }
    }
  }
  assert.equal(ignoredGroups.size, 2, 'each ignored run has its own concurrency group');
});

test('label filtering retains path selection, detector fail-safe and dependency failure behavior', () => {
  const value = context('pull_request', { action: 'synchronize' });
  value.needs.changes.outputs = Object.fromEntries(jobs.map(({ id }) => [id, 'false']));
  assert.deepEqual(selected(value), ['changes', 'secrets-scan']);
  value.needs.changes.result = 'failure';
  assert.deepEqual(selected(value), requiredNames);
  value.needs.core.result = 'failure';
  assert.ok(!selected(value).includes('core-consumers'), 'consumer check cannot use a failed package producer');
  assert.ok(selected(value).includes('extension'), 'extension must report producer failure instead of a passing skip');
  value.cancelled = true;
  assert.ok(!selected(value).some((id) => id !== 'changes' && id !== 'secrets-scan'),
    'explicit always() build conditions must still reject cancelled work');
});

test('extension waits for both producers and stages the same-run Core package before typecheck', () => {
  const extension = jobs.find(({ id }) => id === 'extension').body;
  assert.equal(field(extension, 'needs', 4), '[changes, wasm, core]');
  const guard = step(extension, 'Require successful extension artifact producers');
  for (const result of ['failure', 'cancelled', 'skipped']) {
    for (const producer of ['wasm', 'core']) {
      const value = context();
      value.needs[producer].result = result;
      assert.equal(evaluate(field(guard, 'if', 8), value), true);
    }
  }
  assert.equal(evaluate(field(guard, 'if', 8), context()), false);
  assert.match(guard, /exit 1/);
  const download = step(extension, 'Download verified Core package');
  const producer = step(jobs.find(({ id }) => id === 'core').body,
    'Upload the isolated Core package for SDK and extension consumers');
  assert.equal(field(download, 'name', 10), field(producer, 'name', 10));
  assert.match(download, /uses: actions\/download-artifact@v4/);
  assert.ok(!/\b(?:run-id|repository):/.test(download), 'download must stay within this workflow run');
  assert.ok(extension.indexOf('Stage Core dist for extension consumers') < extension.indexOf('run: yarn typecheck'));
  assert.ok(!extension.includes('yarn core:build'), 'extension CI reuses Core instead of rebuilding it');
});

test('Core artifact staging handles a fresh checkout and rejects missing, ambiguous or incomplete packages', () => {
  const body = step(workflow, 'Stage Core dist for extension consumers');
  const script = body.split('        run: |\n')[1].split('\n')
    .filter((line) => line.trim()).map((line) => {
      assert.ok(line.startsWith('          '));
      return line.slice(10);
    }).join('\n');
  const entries = ['index.js', 'index.d.ts', 'adapters/index.js', 'adapters/index.d.ts',
    'decoders.js', 'decoders.d.ts', 'runtime/wasm/dambi_core_wasm.js', 'runtime/wasm/dambi_core_wasm_bg.wasm'];
  const root = mkdtempSync(join(tmpdir(), 'dambi-core-staging-'));
  try {
    for (const scenario of ['complete', 'missing', 'ambiguous', 'incomplete', 'stale-dist']) {
      const cwd = join(root, scenario);
      const runnerTemp = join(cwd, 'runner-temp');
      const download = join(runnerTemp, 'core-consumer-package');
      const source = join(cwd, 'tar-source');
      mkdirSync(download, { recursive: true });
      mkdirSync(join(cwd, 'packages/core'), { recursive: true });
      writeFileSync(join(cwd, 'packages/core/package.json'), 'checkout manifest');
      mkdirSync(join(source, 'package'), { recursive: true });
      writeFileSync(join(source, 'package/package.json'), 'artifact manifest');
      for (const entry of entries) {
        if (scenario === 'incomplete' && entry.endsWith('.wasm')) continue;
        const path = join(source, 'package/dist', entry);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, 'artifact');
      }
      const count = scenario === 'missing' ? 0 : scenario === 'ambiguous' ? 2 : 1;
      for (let i = 0; i < count; i++) {
        const tar = spawnSync('tar', ['-czf', join(download, `core-${i}.tgz`), '-C', source, 'package']);
        assert.equal(tar.status, 0, tar.stderr?.toString());
      }
      if (scenario === 'stale-dist') mkdirSync(join(cwd, 'packages/core/dist'));
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
        cwd, env: { ...process.env, RUNNER_TEMP: runnerTemp }, encoding: 'utf8',
      });
      if (result.error) throw result.error;
      assert.equal(result.status === 0, scenario === 'complete', `${scenario}: ${result.stderr}`);
      assert.equal(readFileSync(join(cwd, 'packages/core/package.json'), 'utf8'), 'checkout manifest');
      if (scenario === 'complete') {
        for (const entry of entries) assert.equal(readFileSync(join(cwd, 'packages/core/dist', entry), 'utf8'), 'artifact');
      } else if (scenario === 'missing' || scenario === 'ambiguous') {
        assert.equal(existsSync(join(cwd, 'packages/core/dist')), false);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extension release builds production Core once from the tag before packaging without weakening release guards', () => {
  const release = readFileSync(new URL('../../.github/workflows/extension-release.yml', import.meta.url), 'utf8');
  const build = step(release, 'Build Core SDK for extension release');
  assert.match(build, /yarn install --immutable --mode=skip-build\n +yarn core:build/);
  assert.equal(release.match(/yarn core:build/g)?.length, 1);
  assert.ok(release.indexOf('Require extension release tag') < release.indexOf('Build Core SDK'));
  assert.ok(release.indexOf('Require prod build config') < release.indexOf('Build Core SDK'));
  assert.ok(release.indexOf('Build Core SDK') < release.indexOf('Build + zip Chrome dev/QA and Web Store packages'));
  assert.ok(!release.includes('DAMBI_ALLOW_INSECURE_REGISTRY'));
  assert.match(release, /test "\$\{DAMBI_REQUIRE_BUNDLE_SIGNATURE\}" = "true"/);
});
