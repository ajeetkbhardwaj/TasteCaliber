import { DatabaseSync } from 'node:sqlite';
import {
  PipelineStepTrace,
  RlEpisode,
  SignalType,
  TASTE_CATEGORIES,
  TasteCategory,
  TasteLearning,
  TasteScope,
} from '../src/engine/types.ts';
import {
  classifyWithTaste1,
  findSimilarLearning,
  lintTasteMarkdown,
  normalizeRuleKey,
  updateMetaRL,
} from '../src/engine/taste1.ts';
import {
  getLearningById,
  getSettings,
  listLearnings,
  listPackages,
  recordAgentTouch,
  syncAllPackageMarkdown,
} from './db.ts';
import { runStep1InputExtraction, runStep3OutputWriter } from './providers.ts';

export function isTasteLearningEnabled(db: DatabaseSync, scope: TasteScope): boolean {
  const settings = getSettings(db);
  if (scope === 'project' && settings.tasteLearningProject !== undefined) {
    return settings.tasteLearningProject !== 'false';
  }
  if (settings.tasteLearningUser !== undefined) {
    return settings.tasteLearningUser !== 'false';
  }
  return true;
}

export async function processTasteSignal(
  db: DatabaseSync,
  input: {
    sourceAgent?: string;
    transport?: 'http' | 'stdio';
    signalType: SignalType;
    scope?: TasteScope;
    filePath?: string | null;
    rawInput: string;
    diffBefore?: string | null;
    diffAfter?: string | null;
  },
): Promise<PipelineStepTrace> {
  const sourceAgent = input.sourceAgent?.trim() || 'Workbench';
  const scope: TasteScope = input.scope ?? 'project';

  if (input.transport) {
    recordAgentTouch(db, sourceAgent, input.transport);
  }

  // Step 1: Input extraction (Local/NVIDIA/OpenRouter fallback chain or deterministic structural parser)
  const step1 = await runStep1InputExtraction(db, {
    rawInput: input.rawInput,
    diffBefore: input.diffBefore,
    diffAfter: input.diffAfter,
    filePath: input.filePath,
    signalType: input.signalType,
  });

  // Step 2: taste-1 Meta Neuro-Symbolic Classifier
  const existingLearnings = listLearnings(db);
  const step2 = classifyWithTaste1({
    extracted: step1,
    signalType: input.signalType,
    filePath: input.filePath,
    diffBefore: input.diffBefore,
    diffAfter: input.diffAfter,
    existingLearnings,
  });

  const now = new Date().toISOString();
  const packages = listPackages(db);
  const targetPkg =
    packages.find((p) => p.scope === scope) ??
    packages.find((p) => p.scope === 'project') ??
    packages[0];

  const reward =
    input.signalType === 'accept'
      ? 1.0
      : input.signalType === 'edit' || input.signalType === 'diff'
        ? 0.75
        : input.signalType === 'reject'
          ? -0.8
          : 0.4;

  // Check if taste learning is paused for this scope -> dry-run evaluation without persisting
  const learningEnabled = isTasteLearningEnabled(db, scope);
  if (!learningEnabled) {
    const simulatedLearning: TasteLearning = {
      id: 'dry-run-session-only',
      packageId: targetPkg.id,
      scope,
      category: step2.category,
      ruleKey: step2.ruleKey,
      ruleText: step1.candidateRule,
      rationale: `${step1.rationale} (Session-only: taste learning is currently paused)`,
      confidence: step2.initialConfidence,
      status: step2.recommendedStatus,
      rewardSum: reward,
      acceptCount: reward > 0 ? 1 : 0,
      rejectCount: reward < 0 ? 1 : 0,
      klDivergence: 0,
      evidenceCount: 1,
      conflictsWithId: step2.contradictsId,
      createdAt: now,
      updatedAt: now,
    };
    const simulatedRl = updateMetaRL({
      confidenceBefore: step2.initialConfidence,
      reward,
      evidenceCount: 1,
      hasConflict: Boolean(step2.contradictsId),
    });
    const scopeLearnings = listLearnings(db, { packageId: targetPkg.id });
    const step3 = await runStep3OutputWriter(db, {
      title: targetPkg.name,
      scope: targetPkg.scope,
      learnings: scopeLearnings,
    });
    return {
      dryRun: true,
      step1,
      step2,
      step3,
      step4: {
        learning: simulatedLearning,
        rlEpisode: {
          id: 'dry-run-ep',
          learningId: simulatedLearning.id,
          reward,
          baselineProb: simulatedRl.baselineProb,
          policyProb: simulatedRl.policyProb,
          klPenalty: simulatedRl.klPenalty,
          objectiveScore: simulatedRl.objectiveScore,
          confidenceBefore: step2.initialConfidence,
          confidenceAfter: simulatedRl.confidenceAfter,
          createdAt: now,
        },
        lint: lintTasteMarkdown('.tastecaliber/taste/taste.md', step3.markdownPreview),
        syncedFiles: [],
      },
    };
  }

  // Semantic + exact ruleKey match to prevent duplicate paraphrased rules
  const matchedExisting = findSimilarLearning({
    candidateRule: step1.candidateRule,
    ruleKey: step2.ruleKey,
    category: step2.category,
    scope,
    existingLearnings,
    contradictsId: step2.contradictsId,
  });

  let savedLearning: TasteLearning;
  let rlEpisode: RlEpisode;

  if (matchedExisting) {
    const rl = updateMetaRL({
      confidenceBefore: matchedExisting.confidence,
      reward,
      evidenceCount: matchedExisting.evidenceCount + 1,
      hasConflict: Boolean(matchedExisting.conflictsWithId),
    });

    const newAccept = matchedExisting.acceptCount + (reward > 0 ? 1 : 0);
    const newReject = matchedExisting.rejectCount + (reward < 0 ? 1 : 0);

    db.prepare(
      `UPDATE learnings
       SET confidence = ?, status = ?, reward_sum = ?, accept_count = ?, reject_count = ?,
           kl_divergence = ?, evidence_count = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      rl.confidenceAfter,
      rl.statusAfter,
      matchedExisting.rewardSum + reward,
      newAccept,
      newReject,
      rl.klPenalty,
      matchedExisting.evidenceCount + 1,
      now,
      matchedExisting.id,
    );

    const epId = `ep-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    db.prepare(
      `INSERT INTO rl_episodes (id, learning_id, reward, baseline_prob, policy_prob, kl_penalty, objective_score, confidence_before, confidence_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      epId,
      matchedExisting.id,
      reward,
      rl.baselineProb,
      rl.policyProb,
      rl.klPenalty,
      rl.objectiveScore,
      matchedExisting.confidence,
      rl.confidenceAfter,
      now,
    );

    rlEpisode = {
      id: epId,
      learningId: matchedExisting.id,
      reward,
      baselineProb: rl.baselineProb,
      policyProb: rl.policyProb,
      klPenalty: rl.klPenalty,
      objectiveScore: rl.objectiveScore,
      confidenceBefore: matchedExisting.confidence,
      confidenceAfter: rl.confidenceAfter,
      createdAt: now,
    };

    savedLearning = getLearningById(db, matchedExisting.id)!;
  } else {
    const newId = `lrn-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const rl = updateMetaRL({
      confidenceBefore: step2.initialConfidence,
      reward: step2.isPreference ? reward : -0.5,
      evidenceCount: 1,
      hasConflict: Boolean(step2.contradictsId),
    });

    const finalStatus = step2.isPreference ? step2.recommendedStatus : 'archived';
    const finalConf = step2.isPreference ? step2.initialConfidence : rl.confidenceAfter;

    db.prepare(
      `INSERT INTO learnings (
        id, package_id, scope, category, rule_key, rule_text, rationale, confidence, status,
        reward_sum, accept_count, reject_count, kl_divergence, evidence_count, conflicts_with_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId,
      targetPkg.id,
      scope,
      step2.category,
      step2.ruleKey,
      step1.candidateRule,
      step1.rationale,
      finalConf,
      finalStatus,
      reward,
      reward > 0 ? 1 : 0,
      reward < 0 ? 1 : 0,
      rl.klPenalty,
      1,
      step2.contradictsId,
      now,
      now,
    );

    const epId = `ep-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    db.prepare(
      `INSERT INTO rl_episodes (id, learning_id, reward, baseline_prob, policy_prob, kl_penalty, objective_score, confidence_before, confidence_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      epId,
      newId,
      reward,
      rl.baselineProb,
      rl.policyProb,
      rl.klPenalty,
      rl.objectiveScore,
      step2.initialConfidence,
      finalConf,
      now,
    );

    rlEpisode = {
      id: epId,
      learningId: newId,
      reward,
      baselineProb: rl.baselineProb,
      policyProb: rl.policyProb,
      klPenalty: rl.klPenalty,
      objectiveScore: rl.objectiveScore,
      confidenceBefore: step2.initialConfidence,
      confidenceAfter: finalConf,
      createdAt: now,
    };

    savedLearning = getLearningById(db, newId)!;
  }

  // Record Signal in SQLite
  const sigId = `sig-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  db.prepare(
    `INSERT INTO signals (id, source_agent, signal_type, file_path, raw_input, diff_before, diff_after, extracted_signal_json, taste1_decision_json, reward_delta, learning_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sigId,
    sourceAgent,
    input.signalType,
    input.filePath ?? null,
    input.rawInput,
    input.diffBefore ?? null,
    input.diffAfter ?? null,
    JSON.stringify(step1),
    JSON.stringify(step2),
    reward,
    savedLearning.id,
    now,
  );

  // Step 3 & Step 4: Compile markdown, sync .tastecaliber/taste/ files, lint
  const scopeLearnings = listLearnings(db, { packageId: targetPkg.id });
  const step3 = await runStep3OutputWriter(db, {
    title: targetPkg.name,
    scope: targetPkg.scope,
    learnings: scopeLearnings,
  });

  const syncedFiles = syncAllPackageMarkdown(db);
  const lint = lintTasteMarkdown('.tastecaliber/taste/taste.md', step3.markdownPreview);

  return {
    dryRun: false,
    step1,
    step2,
    step3,
    step4: {
      learning: savedLearning,
      rlEpisode,
      lint,
      syncedFiles,
    },
  };
}

export function applyLearningFeedback(
  db: DatabaseSync,
  learningId: string,
  feedback: 'accept' | 'reject',
): { learning: TasteLearning; episode: RlEpisode; syncedFiles: string[] } {
  const existing = getLearningById(db, learningId);
  if (!existing) {
    throw new Error(`Learning ${learningId} not found`);
  }

  const reward = feedback === 'accept' ? 1.0 : -1.0;
  const rl = updateMetaRL({
    confidenceBefore: existing.confidence,
    reward,
    evidenceCount: existing.evidenceCount + 1,
    hasConflict: existing.status === 'conflicted',
  });

  const now = new Date().toISOString();
  const acceptCount = existing.acceptCount + (feedback === 'accept' ? 1 : 0);
  const rejectCount = existing.rejectCount + (feedback === 'reject' ? 1 : 0);

  db.prepare(
    `UPDATE learnings
     SET confidence = ?, status = ?, reward_sum = ?, accept_count = ?, reject_count = ?,
         kl_divergence = ?, evidence_count = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    rl.confidenceAfter,
    rl.statusAfter,
    existing.rewardSum + reward,
    acceptCount,
    rejectCount,
    rl.klPenalty,
    existing.evidenceCount + 1,
    now,
    existing.id,
  );

  const epId = `ep-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  db.prepare(
    `INSERT INTO rl_episodes (id, learning_id, reward, baseline_prob, policy_prob, kl_penalty, objective_score, confidence_before, confidence_after, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    epId,
    existing.id,
    reward,
    rl.baselineProb,
    rl.policyProb,
    rl.klPenalty,
    rl.objectiveScore,
    existing.confidence,
    rl.confidenceAfter,
    now,
  );

  const syncedFiles = syncAllPackageMarkdown(db);
  return {
    learning: getLearningById(db, existing.id)!,
    episode: {
      id: epId,
      learningId: existing.id,
      reward,
      baselineProb: rl.baselineProb,
      policyProb: rl.policyProb,
      klPenalty: rl.klPenalty,
      objectiveScore: rl.objectiveScore,
      confidenceBefore: existing.confidence,
      confidenceAfter: rl.confidenceAfter,
      createdAt: now,
    },
    syncedFiles,
  };
}

export function editLearning(
  db: DatabaseSync,
  learningId: string,
  updates: { ruleText?: string; rationale?: string; category?: TasteCategory },
): { learning: TasteLearning; syncedFiles: string[] } {
  const existing = getLearningById(db, learningId);
  if (!existing) {
    throw new Error(`Learning ${learningId} not found`);
  }

  const nextRule = updates.ruleText?.trim() || existing.ruleText;
  const nextRationale = updates.rationale !== undefined ? updates.rationale.trim() : existing.rationale;
  const nextCategory =
    updates.category && TASTE_CATEGORIES.includes(updates.category)
      ? updates.category
      : existing.category;
  const nextKey = normalizeRuleKey(nextRule);
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE learnings SET rule_text = ?, rationale = ?, category = ?, rule_key = ?, updated_at = ? WHERE id = ?`,
  ).run(nextRule, nextRationale, nextCategory, nextKey, now, learningId);

  const syncedFiles = syncAllPackageMarkdown(db);
  return {
    learning: getLearningById(db, learningId)!,
    syncedFiles,
  };
}

export function archiveOrDeleteLearning(
  db: DatabaseSync,
  learningId: string,
  hardDelete = false,
): { archived: boolean; syncedFiles: string[] } {
  const existing = getLearningById(db, learningId);
  if (!existing) {
    throw new Error(`Learning ${learningId} not found`);
  }

  if (hardDelete) {
    db.prepare('DELETE FROM learnings WHERE id = ?').run(learningId);
  } else {
    db.prepare(`UPDATE learnings SET status = 'archived', conflicts_with_id = NULL, updated_at = ? WHERE id = ?`).run(
      new Date().toISOString(),
      learningId,
    );
  }

  const syncedFiles = syncAllPackageMarkdown(db);
  return { archived: true, syncedFiles };
}

export function resolveLearningConflict(
  db: DatabaseSync,
  conflictedId: string,
  resolution: 'keep_existing' | 'accept_new' | 'keep_both',
): { resolved: TasteLearning; syncedFiles: string[] } {
  const conflicted = getLearningById(db, conflictedId);
  if (!conflicted) {
    throw new Error(`Learning ${conflictedId} not found`);
  }

  const now = new Date().toISOString();
  const rivalId = conflicted.conflictsWithId;

  if (resolution === 'keep_existing') {
    db.prepare(`UPDATE learnings SET status = 'archived', conflicts_with_id = NULL, updated_at = ? WHERE id = ?`).run(
      now,
      conflicted.id,
    );
    if (rivalId) {
      db.prepare(`UPDATE learnings SET confidence = MIN(0.99, confidence + 0.05), updated_at = ? WHERE id = ?`).run(
        now,
        rivalId,
      );
    }
  } else if (resolution === 'accept_new') {
    if (rivalId) {
      db.prepare(`UPDATE learnings SET status = 'archived', updated_at = ? WHERE id = ?`).run(now, rivalId);
    }
    const promotedConf = Math.max(conflicted.confidence, 0.76);
    db.prepare(
      `UPDATE learnings SET status = 'enforced', confidence = ?, conflicts_with_id = NULL, updated_at = ? WHERE id = ?`,
    ).run(promotedConf, now, conflicted.id);
  } else {
    db.prepare(
      `UPDATE learnings SET status = 'hint', conflicts_with_id = NULL, updated_at = ? WHERE id = ?`,
    ).run(now, conflicted.id);
  }

  const syncedFiles = syncAllPackageMarkdown(db);
  return {
    resolved: getLearningById(db, conflicted.id)!,
    syncedFiles,
  };
}

export async function bootstrapTasteFromSnippets(
  db: DatabaseSync,
  params: {
    text: string;
    filePath?: string;
    scope?: TasteScope;
    sourceAgent?: string;
  },
): Promise<{
  processedCount: number;
  learned: TasteLearning[];
  skippedNoise: number;
  syncedFiles: string[];
}> {
  const lines = params.text
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter((l) => l.length >= 10);

  const candidates = lines.slice(0, 12);
  const learned: TasteLearning[] = [];
  let skippedNoise = 0;

  for (const line of candidates) {
    const trace = await processTasteSignal(db, {
      sourceAgent: params.sourceAgent || 'Bootstrap (/learn-taste)',
      signalType: 'prompt',
      scope: params.scope ?? 'project',
      filePath: params.filePath ?? null,
      rawInput: line,
    });
    if (trace.step2.isPreference) {
      learned.push(trace.step4.learning);
    } else {
      skippedNoise++;
    }
  }

  const syncedFiles = syncAllPackageMarkdown(db);
  return {
    processedCount: candidates.length,
    learned,
    skippedNoise,
    syncedFiles,
  };
}

export function pushOrPullPackages(
  db: DatabaseSync,
  action: 'push' | 'pull',
  fromScope: TasteScope,
  toScope: TasteScope,
  overwrite = false,
): { added: number; updated: number; unchanged: number; syncedFiles: string[] } {
  const sourceLearnings = listLearnings(db, { scope: fromScope }).filter((l) => l.status !== 'archived');
  const targetPackages = listPackages(db);
  const targetPkg = targetPackages.find((p) => p.scope === toScope) ?? targetPackages[0];
  const targetLearnings = listLearnings(db, { scope: toScope });

  const now = new Date().toISOString();
  let added = 0;
  let updated = 0;
  let unchanged = 0;

  if (overwrite) {
    db.prepare('DELETE FROM learnings WHERE scope = ?').run(toScope);
  }

  for (const src of sourceLearnings) {
    const match = !overwrite
      ? targetLearnings.find((t) => t.ruleKey === src.ruleKey && t.category === src.category)
      : undefined;

    if (!match) {
      const newId = `lrn-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      db.prepare(
        `INSERT INTO learnings (
          id, package_id, scope, category, rule_key, rule_text, rationale, confidence, status,
          reward_sum, accept_count, reject_count, kl_divergence, evidence_count, conflicts_with_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId,
        targetPkg.id,
        toScope,
        src.category,
        src.ruleKey,
        src.ruleText,
        src.rationale,
        src.confidence,
        src.status === 'conflicted' ? 'hint' : src.status,
        src.rewardSum,
        src.acceptCount,
        src.rejectCount,
        src.klDivergence,
        src.evidenceCount,
        null,
        now,
        now,
      );
      added++;
    } else if (Math.abs(match.confidence - src.confidence) >= 0.02) {
      const mergedConf = Math.round(((match.confidence + src.confidence) / 2) * 10000) / 10000;
      db.prepare('UPDATE learnings SET confidence = ?, updated_at = ? WHERE id = ?').run(mergedConf, now, match.id);
      updated++;
    } else {
      unchanged++;
    }
  }

  const syncedFiles = syncAllPackageMarkdown(db);
  return { added, updated, unchanged, syncedFiles };
}
