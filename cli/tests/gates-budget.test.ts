import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { budgetLine, recordFailure } from '../src/commands/gates.ts';

test('recordFailure: consecutive failures at one gate count up; a different gate starts over', () => {
  const ledger = join(mkdtempSync(join(tmpdir(), 'gates-')), 'gates-attempts.json');
  assert.equal(recordFailure(ledger, '--verify'), 1);
  assert.equal(recordFailure(ledger, '--verify'), 2);
  assert.equal(recordFailure(ledger, '--verify'), 3);
  assert.equal(recordFailure(ledger, 'lint'), 1, 'progress to another gate is not the same loop');
});

test('budgetLine: silent for two corrections, says STOP on the third, and names the gate', () => {
  assert.equal(budgetLine('--verify', 1), null);
  assert.equal(budgetLine('--verify', 2), null);
  assert.match(budgetLine('--verify', 3) ?? '', /failure 3 in a row at --verify.*STOP/);
});
