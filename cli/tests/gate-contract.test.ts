// content-gates.ts declares the shape of gates that live in CONTENT, so the two sides can drift
// without either one failing to compile: the loader's types are structural claims about modules it
// only imports at run time. This holds them together against the real modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentRoot } from '../src/config.ts';
import { loadDesignGate, loadLintGate } from '../src/gates/content-gates.ts';

test('the lint gate loads from content and returns the declared finding shape', async () => {
  const lintTemplate = await loadLintGate(contentRoot());
  const findings = lintTemplate('<html><style>.x{display:grid}</style><body><div class="x">hi</div></body></html>');
  assert.ok(findings.length > 0, 'a grid document produces findings');
  for (const f of findings) {
    assert.equal(typeof f.rule, 'string');
    assert.equal(typeof f.message, 'string');
    assert.ok(f.severity === 'error' || f.severity === 'warn', `severity is error|warn, got ${f.severity}`);
  }
  assert.ok(findings.some((f) => f.rule === 'css-grid'), 'the engine-limit rule fires by its own name');
});

test('the design gate loads from content and returns the declared result shape', async () => {
  const gate = await loadDesignGate(contentRoot());
  const result = gate(mkdtempSync(join(tmpdir(), 'gate-contract-')));
  assert.equal(typeof result.documents, 'number');
  assert.ok(Array.isArray(result.findings));
  assert.ok(result.findings.some((f) => f.rule === 'no-design-system'), 'an empty run has no system, and the gate says so');
});

test('a directory that is not a content tree fails loudly rather than silently gating nothing', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'gate-contract-empty-'));
  await assert.rejects(() => loadLintGate(empty), /not a complete Open Edit content tree/);
  await assert.rejects(() => loadDesignGate(empty), /not a complete Open Edit content tree/);
});
