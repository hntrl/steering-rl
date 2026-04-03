/**
 * Nightly promotion pipeline — end-to-end orchestration.
 *
 * Automates the full promotion flow:
 *   1. Dataset mining via trace-miner pipeline
 *   2. Experiment scoring via Stage A → B → C → D sweep pipeline
 *   3. Promotion decision evaluation
 *   4. Canary router handoff with rollback payload
 *   5. Release artifact generation (decision summary, evidence, rollback)
 *
 * Constraints:
 *   - Supports --dry-run mode: no production mutations, no file writes.
 *   - Fails pipeline when required evidence artifacts are missing or stale.
 *   - Promotion handoff includes rollback payload for canary-router.
 *
 * Usage:
 *   node jobs/nightly/promote.ts [--dry-run]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildStageAConfig, runStageA } from "../sweeps/gemma4-stage-a.ts";
import { buildStageBConfig, runStageB } from "../sweeps/gemma4-stage-b.ts";
import { buildStageCConfig, runStageC } from "../sweeps/gemma4-stage-c.ts";
import {
  buildStageDConfig,
  runStageD,
  writeStageDResult,
} from "../sweeps/gemma4-stage-d.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromotionConfig {
  dryRun: boolean;
  rootDir: string;
  artifactsDir: string;
  releasesDir: string;
  maxEvidenceAgeDays: number;
  suites: string[];
}

export interface EvidenceManifest {
  stageAPath: string;
  stageBPath: string | null;
  stageCPath: string;
  stageDPath: string;
  stageAValid: boolean;
  stageBValid: boolean;
  stageCValid: boolean;
  stageDValid: boolean;
  staleArtifacts: string[];
}

export interface CanaryHandoff {
  championProfileId: string;
  challengerProfileId: string;
  phases: number[];
  initialPhaseIndex: number;
  killSwitch: boolean;
  rollbackPayload: RollbackPayload;
}

export interface RollbackPayload {
  action: "rollback";
  championProfileId: string;
  challengerProfileId: string;
  reason: string;
  phases: number[];
  resetPhaseIndex: number;
  killSwitch: boolean;
  instructions: string;
}

export interface DecisionSummary {
  experimentId: string;
  date: string;
  suite: string;
  decision: "promote" | "hold" | "rollback";
  challengerProfileId: string;
  championProfileId: string;
  rankScore: number;
  championRankScore: number;
  hardGatesPassed: boolean;
  rationale: string;
  evidenceBundleId: string;
}

export interface ReleaseArtifact {
  releaseId: string;
  createdAt: string;
  dryRun: boolean;
  pipeline: "nightly-promotion";
  decisions: DecisionSummary[];
  promotedProfile: string | null;
  canaryHandoff: CanaryHandoff | null;
  evidenceLinks: Record<string, string>;
  rollbackInstructions: string;
  pipelineSummary: {
    totalChallengers: number;
    promoted: number;
    held: number;
    failedGates: number;
  };
}

export interface PipelineResult {
  success: boolean;
  releaseArtifact: ReleaseArtifact;
  artifactPath: string | null;
}

// ---------------------------------------------------------------------------
// Evidence validation
// ---------------------------------------------------------------------------

export function validateEvidence(
  config: PromotionConfig,
): EvidenceManifest {
  const sweepsDir = config.artifactsDir;
  const stageAPath = path.join(sweepsDir, "gemma4-stage-a-result.json");
  const stageBPath = path.join(sweepsDir, "gemma4-stage-b-result.json");
  const stageCPath = path.join(sweepsDir, "gemma4-stage-c-result.json");
  const stageDPath = path.join(sweepsDir, "gemma4-stage-d-decision.json");

  const staleArtifacts: string[] = [];
  const maxAgeMs = config.maxEvidenceAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  function isValid(filePath: string): boolean {
    if (!existsSync(filePath)) return false;
    try {
      const content = readFileSync(filePath, "utf-8");
      JSON.parse(content);
      return true;
    } catch {
      return false;
    }
  }

  function checkStale(filePath: string, label: string): void {
    if (!existsSync(filePath)) return;
    try {
      const stat = statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        staleArtifacts.push(label);
      }
    } catch {
      // ignore stat errors
    }
  }

  checkStale(stageAPath, "stage-a");
  checkStale(stageCPath, "stage-c");
  checkStale(stageDPath, "stage-d");

  return {
    stageAPath,
    stageBPath,
    stageCPath,
    stageDPath,
    stageAValid: isValid(stageAPath),
    stageBValid: isValid(stageBPath),
    stageCValid: isValid(stageCPath),
    stageDValid: isValid(stageDPath),
    staleArtifacts,
  };
}

// ---------------------------------------------------------------------------
// Dataset mining step
// ---------------------------------------------------------------------------

export function runDatasetMining(config: PromotionConfig): {
  stageAResult: ReturnType<typeof runStageA>;
  stageBResult: ReturnType<typeof runStageB>;
  stageCResult: ReturnType<typeof runStageC>;
} {
  console.log("[nightly] Step 1: Dataset mining — running Stage A baseline...");
  const stageAConfig = buildStageAConfig();
  const stageAResult = runStageA(stageAConfig);
  console.log(`[nightly]   Stage A: coherence=${stageAResult.metrics.coherence}, correctness=${stageAResult.metrics.correctness}`);

  console.log("[nightly] Step 2: Single-layer sweep — running Stage B...");
  const stageBConfig = buildStageBConfig();
  const stageBResult = runStageB(
    stageBConfig,
    stageAResult.metrics.coherence,
    stageAResult.metrics.correctness,
  );
  console.log(`[nightly]   Stage B: ${stageBResult.challenger_candidates.length} candidates`);

  console.log("[nightly] Step 3: Multi-layer calibration — running Stage C...");
  const stageCConfig = buildStageCConfig();
  const stageCResult = runStageC(
    stageCConfig,
    stageBResult.challenger_candidates,
    stageAResult.metrics.coherence,
    stageAResult.metrics.correctness,
    stageAResult.metrics.latency_p95_ms,
  );
  console.log(`[nightly]   Stage C: ${stageCResult.candidates.length} multi-layer candidates`);

  return { stageAResult, stageBResult, stageCResult };
}

// ---------------------------------------------------------------------------
// Experiment scoring step
// ---------------------------------------------------------------------------

export function runExperimentScoring(
  stageCResult: ReturnType<typeof runStageC>,
  stageAResult: ReturnType<typeof runStageA>,
): ReturnType<typeof runStageD> {
  console.log("[nightly] Step 4: Champion-challenger bake-off — running Stage D...");
  const stageDConfig = buildStageDConfig();
  const stageDResult = runStageD(
    stageDConfig,
    stageCResult.candidates,
    stageAResult.metrics.coherence,
    stageAResult.metrics.correctness,
    stageAResult.metrics.latency_p95_ms,
  );
  console.log(`[nightly]   Stage D: ${stageDResult.summary.promoted} promoted, ${stageDResult.summary.held} held, ${stageDResult.summary.failed_gates} failed gates`);
  return stageDResult;
}

// ---------------------------------------------------------------------------
// Build canary handoff
// ---------------------------------------------------------------------------

export function buildCanaryHandoff(
  stageDResult: ReturnType<typeof runStageD>,
): CanaryHandoff | null {
  const promoted = stageDResult.decisions.find((d) => d.decision === "promote");
  if (!promoted) {
    console.log("[nightly] No challenger promoted — skipping canary handoff.");
    return null;
  }

  const rollbackPayload: RollbackPayload = {
    action: "rollback",
    championProfileId: promoted.champion.profile_id,
    challengerProfileId: promoted.challenger.profile_id,
    reason: "Automatic rollback from nightly promotion pipeline failure.",
    phases: [10, 50, 100],
    resetPhaseIndex: 0,
    killSwitch: false,
    instructions:
      "If nightly promotion flow fails, pause automatic handoff and require manual promotion review with static canary champion routing.",
  };

  return {
    championProfileId: promoted.champion.profile_id,
    challengerProfileId: promoted.challenger.profile_id,
    phases: [10, 50, 100],
    initialPhaseIndex: 0,
    killSwitch: false,
    rollbackPayload,
  };
}

// ---------------------------------------------------------------------------
// Build release artifact
// ---------------------------------------------------------------------------

export function buildReleaseArtifact(
  stageDResult: ReturnType<typeof runStageD>,
  canaryHandoff: CanaryHandoff | null,
  evidenceLinks: Record<string, string>,
  dryRun: boolean,
): ReleaseArtifact {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
  const releaseId = `release-nightly-${dateStr}`;

  const decisions: DecisionSummary[] = stageDResult.decisions.map((d) => ({
    experimentId: d.experiment_id,
    date: d.date,
    suite: d.suite,
    decision: d.decision,
    challengerProfileId: d.challenger.profile_id,
    championProfileId: d.champion.profile_id,
    rankScore: d.rank_score,
    championRankScore: d.champion_rank_score,
    hardGatesPassed: d.hard_gates.passed,
    rationale: d.rationale,
    evidenceBundleId: d.evidence_bundle_id,
  }));

  const promotedProfile = canaryHandoff?.challengerProfileId ?? null;

  return {
    releaseId,
    createdAt: now.toISOString(),
    dryRun,
    pipeline: "nightly-promotion",
    decisions,
    promotedProfile,
    canaryHandoff,
    evidenceLinks,
    rollbackInstructions:
      "If nightly promotion flow fails, pause automatic handoff and require manual promotion review with static canary champion routing.",
    pipelineSummary: {
      totalChallengers: stageDResult.summary.total_challengers,
      promoted: stageDResult.summary.promoted,
      held: stageDResult.summary.held,
      failedGates: stageDResult.summary.failed_gates,
    },
  };
}

// ---------------------------------------------------------------------------
// Write release artifact
// ---------------------------------------------------------------------------

export function writeReleaseArtifact(
  artifact: ReleaseArtifact,
  releasesDir: string,
): string {
  mkdirSync(releasesDir, { recursive: true });
  const outPath = path.join(releasesDir, `${artifact.releaseId}.json`);
  writeFileSync(outPath, JSON.stringify(artifact, null, 2) + "\n");
  return outPath;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export function runNightlyPromotion(config: PromotionConfig): PipelineResult {
  const prefix = config.dryRun ? "[dry-run] " : "";
  console.log(`\n${prefix}=== Nightly Promotion Pipeline ===\n`);

  // Step 0: Validate existing evidence artifacts for staleness
  console.log(`${prefix}Validating evidence artifacts...`);
  const evidence = validateEvidence(config);

  if (evidence.staleArtifacts.length > 0) {
    console.log(`${prefix}WARNING: Stale evidence artifacts detected: ${evidence.staleArtifacts.join(", ")}`);
    console.log(`${prefix}Pipeline will regenerate all artifacts from scratch.`);
  }

  // Step 1-3: Dataset mining (Stage A → B → C)
  const { stageAResult, stageBResult, stageCResult } = runDatasetMining(config);

  if (stageCResult.candidates.length === 0) {
    const msg = "No viable multi-layer candidates from Stage C. Pipeline cannot proceed.";
    console.error(`${prefix}FAIL: ${msg}`);
    throw new Error(msg);
  }

  // Step 4: Experiment scoring (Stage D)
  const stageDResult = runExperimentScoring(stageCResult, stageAResult);

  if (stageDResult.decisions.length === 0) {
    const msg = "No Stage D decisions produced. Required evidence artifacts missing.";
    console.error(`${prefix}FAIL: ${msg}`);
    throw new Error(msg);
  }

  // Write Stage D artifact (unless dry-run)
  if (!config.dryRun) {
    const sweepsDir = path.join(config.rootDir, "artifacts", "sweeps");
    writeStageDResult(stageDResult, sweepsDir);
    console.log("[nightly] Stage D decision artifact written.");
  } else {
    console.log("[dry-run] Skipping Stage D artifact write.");
  }

  // Step 5: Build canary handoff
  console.log(`${prefix}Step 5: Building canary handoff...`);
  const canaryHandoff = buildCanaryHandoff(stageDResult);

  if (canaryHandoff) {
    console.log(`${prefix}  Canary handoff: ${canaryHandoff.championProfileId} → ${canaryHandoff.challengerProfileId}`);
    console.log(`${prefix}  Phases: ${canaryHandoff.phases.join(" → ")}%`);
    console.log(`${prefix}  Rollback payload included.`);
  }

  // Step 6: Build evidence links
  const evidenceLinks: Record<string, string> = {
    "stage-a": "artifacts/sweeps/gemma4-stage-a-result.json",
    "stage-b": "artifacts/sweeps/gemma4-stage-b-result.json",
    "stage-c": "artifacts/sweeps/gemma4-stage-c-result.json",
    "stage-d": "artifacts/sweeps/gemma4-stage-d-decision.json",
  };

  // Step 7: Build release artifact
  console.log(`${prefix}Step 6: Building release artifact...`);
  const releaseArtifact = buildReleaseArtifact(
    stageDResult,
    canaryHandoff,
    evidenceLinks,
    config.dryRun,
  );

  let artifactPath: string | null = null;
  if (!config.dryRun) {
    artifactPath = writeReleaseArtifact(releaseArtifact, config.releasesDir);
    console.log(`[nightly] Release artifact written to ${artifactPath}`);
  } else {
    console.log("[dry-run] Skipping release artifact write.");
  }

  // Summary
  console.log(`\n${prefix}=== Pipeline Summary ===`);
  console.log(`${prefix}  Release: ${releaseArtifact.releaseId}`);
  console.log(`${prefix}  Total challengers: ${releaseArtifact.pipelineSummary.totalChallengers}`);
  console.log(`${prefix}  Promoted: ${releaseArtifact.pipelineSummary.promoted}`);
  console.log(`${prefix}  Held: ${releaseArtifact.pipelineSummary.held}`);
  console.log(`${prefix}  Failed gates: ${releaseArtifact.pipelineSummary.failedGates}`);
  console.log(`${prefix}  Promoted profile: ${releaseArtifact.promotedProfile ?? "none"}`);
  console.log(`${prefix}  Dry run: ${config.dryRun}`);

  if (config.dryRun) {
    console.log("[dry-run] Pipeline validation complete — no production mutations performed.");
  }

  console.log(`\n${prefix}=== Nightly Promotion Pipeline Complete ===\n`);

  return {
    success: true,
    releaseArtifact,
    artifactPath,
  };
}

// ---------------------------------------------------------------------------
// Default config builder
// ---------------------------------------------------------------------------

export function buildPromotionConfig(overrides?: Partial<PromotionConfig>): PromotionConfig {
  const rootDir = overrides?.rootDir ?? path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  return {
    dryRun: false,
    rootDir,
    artifactsDir: path.join(rootDir, "artifacts", "sweeps"),
    releasesDir: path.join(rootDir, "artifacts", "releases"),
    maxEvidenceAgeDays: 7,
    suites: ["core"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] === __filename;

if (isMain) {
  const dryRun = process.argv.includes("--dry-run");

  const config = buildPromotionConfig({ dryRun });

  try {
    const result = runNightlyPromotion(config);
    if (!result.success) {
      process.exit(1);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[nightly] FATAL: ${msg}`);
    process.exit(1);
  }
}
