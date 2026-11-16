import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyWithTaste1,
  compileTasteMarkdown,
  computeRuleSimilarity,
  deterministicExtractSignal,
  findSimilarLearning,
  lintTasteMarkdown,
  updateMetaRL,
} from './taste1';
import { TasteLearning } from './types';

function makeLearning(overrides: Partial<TasteLearning> = {}): TasteLearning {
  return {
    id: 'l-1',
    packageId: 'pkg-project',
    scope: 'project',
    category: 'typescript',
    ruleKey: 'avoid-any-use-unknown',
    ruleText: 'Avoid any in TypeScript and prefer explicit interfaces or unknown',
    rationale: 'Preserves compile-time type safety',
    confidence: 0.82,
    status: 'enforced',
    rewardSum: 1.5,
    acceptCount: 2,
    rejectCount: 0,
    klDivergence: 0.04,
    evidenceCount: 2,
    conflictsWithId: null,
    createdAt: '2026-11-16T00:00:00Z',
    updatedAt: '2026-11-16T00:00:00Z',
    ...overrides,
  };
}

test('taste-1 classifier is strictly deterministic for identical inputs', () => {
  const extracted = deterministicExtractSignal({
    rawInput: 'Use parameterized prepared SQLite statements instead of string interpolation',
    diffBefore: 'db.exec(`SELECT * FROM users WHERE id = ${id}`)',
    diffAfter: 'db.prepare("SELECT * FROM users WHERE id = ?").get(id)',
    filePath: 'server/db.ts',
    signalType: 'edit',
  });

  const first = classifyWithTaste1({
    extracted,
    signalType: 'edit',
    filePath: 'server/db.ts',
    diffBefore: 'db.exec(`SELECT * FROM users WHERE id = ${id}`)',
    diffAfter: 'db.prepare("SELECT * FROM users WHERE id = ?").get(id)',
    existingLearnings: [],
  });

  const second = classifyWithTaste1({
    extracted,
    signalType: 'edit',
    filePath: 'server/db.ts',
    diffBefore: 'db.exec(`SELECT * FROM users WHERE id = ${id}`)',
    diffAfter: 'db.prepare("SELECT * FROM users WHERE id = ?").get(id)',
    existingLearnings: [],
  });

  assert.deepEqual(first, second);
  assert.equal(first.isPreference, true);
  assert.equal(first.category, 'database');
});

test('taste-1 rejects conversational noise as non-preference', () => {
  const extracted = deterministicExtractSignal({
    rawInput: 'looks good',
    signalType: 'prompt',
  });

  const decision = classifyWithTaste1({
    extracted,
    signalType: 'prompt',
    existingLearnings: [],
  });

  assert.equal(decision.isPreference, false);
  assert.equal(decision.recommendedStatus, 'archived');
});

test('symbolic layer flags contradictions instead of overwriting existing preference', () => {
  const existing = makeLearning({
    id: 'l-semi',
    category: 'formatting',
    ruleKey: 'use-semicolons',
    ruleText: 'Always use semicolons at statement boundaries',
    confidence: 0.85,
  });

  const extracted = deterministicExtractSignal({
    rawInput: 'Omit semicolons across TypeScript files',
    signalType: 'edit',
    filePath: 'src/utils.ts',
  });

  const decision = classifyWithTaste1({
    extracted,
    signalType: 'edit',
    filePath: 'src/utils.ts',
    existingLearnings: [existing],
  });

  assert.equal(decision.contradictsId, 'l-semi');
  assert.equal(decision.recommendedStatus, 'conflicted');
  assert.equal(decision.symbolicChecks.noConflictOverwrite, false);
});

test('Meta-RL updater increases confidence on positive reward and bounds within [0.05, 0.99]', () => {
  const up = updateMetaRL({
    confidenceBefore: 0.65,
    reward: 1.0,
    evidenceCount: 1,
    hasConflict: false,
  });
  assert.ok(up.confidenceAfter > 0.65);
  assert.equal(up.statusAfter, 'enforced');

  const down = updateMetaRL({
    confidenceBefore: 0.65,
    reward: -1.0,
    evidenceCount: 1,
    hasConflict: false,
  });
  assert.ok(down.confidenceAfter < 0.65);
  assert.ok(down.confidenceAfter >= 0.05);
});

test('markdown compiler and linter produce valid taste.md and catch invalid confidence', () => {
  const md = compileTasteMarkdown({
    title: 'tastecaliber-core',
    scope: 'project',
    learnings: [makeLearning()],
  });
  const okLint = lintTasteMarkdown('taste.md', md);
  assert.equal(okLint.valid, true);
  assert.equal(okLint.errors, 0);

  const broken = `# Taste Profile: broken\n> Scope: project\n\n## typescript\n- [confidence: 1.45] [enforced] Bad confidence score\n`;
  const badLint = lintTasteMarkdown('broken/taste.md', broken);
  assert.equal(badLint.valid, false);
  assert.equal(badLint.errors, 1);
});

test('findSimilarLearning merges paraphrased rules in the same category and avoids duplicates', () => {
  const existing = makeLearning({
    id: 'lrn-sql-prep',
    category: 'database',
    ruleKey: 'parameterized-sqlite-prepared',
    ruleText: 'Always use parameterized prepared SQLite statements with WAL mode enabled',
  });

  const sim = computeRuleSimilarity(
    'Use parameterized prepared SQLite statements instead of string interpolation',
    existing.ruleText,
  );
  assert.ok(sim >= 0.58, `Expected similarity >= 0.58, got ${sim}`);

  const matched = findSimilarLearning({
    candidateRule: 'Use parameterized prepared SQLite statements',
    ruleKey: 'different-key-phrase',
    category: 'database',
    scope: 'project',
    existingLearnings: [existing],
    contradictsId: null,
  });
  assert.equal(matched?.id, 'lrn-sql-prep');

  const distinct = findSimilarLearning({
    candidateRule: 'Wrap multi-step database writes inside explicit SQLite transactions',
    ruleKey: 'wrap-multi-step-transactions',
    category: 'database',
    scope: 'project',
    existingLearnings: [existing],
    contradictsId: null,
  });
  assert.equal(distinct, null);
});

test('comparative "Prefer A over B" rules do not trigger false-positive conflicts on A', () => {
  const existing = makeLearning({
    id: 'lrn-arch-named',
    category: 'architecture',
    ruleKey: 'prefer-named-exports',
    ruleText: 'Prefer named exports over default exports for composable modules',
  });

  const extracted = deterministicExtractSignal({
    rawInput: 'Prefer named exports and strict TypeScript return types on exported helpers',
    signalType: 'edit',
    filePath: 'src/utils/format.ts',
  });

  const decision = classifyWithTaste1({
    extracted,
    signalType: 'edit',
    filePath: 'src/utils/format.ts',
    existingLearnings: [existing],
  });

  assert.equal(decision.contradictsId, null);
  assert.notEqual(decision.recommendedStatus, 'conflicted');
});
