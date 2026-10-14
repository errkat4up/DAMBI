import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const protection = JSON.parse(readFileSync(new URL('./main-protection.json', import.meta.url), 'utf8'));
const requiredNames = protection.required_status_checks.checks.map(({ context }) => context).sort();
const jobSource = workflow.slice(workflow.indexOf('\njobs:\n'));
const jobs = [...jobSource.matchAll(/^  ([a-z][a-z0-9-]*):\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|$(?![\s\S]))/gm)]
  .map(([, id, body]) => ({ id, name: field(body, 'name', 4), condition: field(body, 'if', 4) }));
const concurrency = workflow.match(/^concurrency:\n([\s\S]*?)(?=^jobs:)/m)?.[1];
assert.ok(concurrency, 'the workflow must declare concurrency');

function field(source, key, indent) {
  const match = source.match(new RegExp(`^ {${indent}}${key}: (.+)$`, 'm'));
  assert.ok(match, `missing ${key} at indentation ${indent}`);
  return match[1];
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
  value.cancelled = true;
  assert.ok(!selected(value).some((id) => id !== 'changes' && id !== 'secrets-scan'),
    'explicit always() build conditions must still reject cancelled work');
});
