import { createHash } from "node:crypto";

/**
 * A single production trace record, representing one failed or weak inference run.
 */
export interface TraceRecord {
  traceId: string;
  input: string;
  output: string;
  profileId: string;
  failureType: string;
  metadata?: Record<string, unknown>;
}

/**
 * A deduplicated eval example ready for dataset export.
 */
export interface EvalExample {
  id: string;
  input: string;
  expectedFailureType: string;
  profileId: string;
  cluster: string;
  sourceTraceIds: string[];
}

/**
 * Produces a deterministic content hash for a trace record.
 * Uses SHA-256 over the normalized input + failureType so identical
 * prompts with the same failure mode always collapse.
 */
export function contentHash(trace: TraceRecord): string {
  const normalized = [trace.input.trim().toLowerCase(), trace.failureType.trim().toLowerCase()].join("\n---\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Assigns a cluster label based on failure type.
 * Deterministic: same failureType always maps to the same cluster.
 */
export function clusterLabel(failureType: string): string {
  const normalized = failureType.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return `cluster-${normalized}`;
}

/**
 * Deduplicates an array of trace records using deterministic content hashing.
 *
 * Strategy:
 * 1. Compute a SHA-256 hash over (normalized input + failureType) for each trace.
 * 2. Group traces by hash — keep first occurrence as canonical example.
 * 3. Assign a deterministic cluster label derived from failureType.
 * 4. Return deduplicated EvalExample[] with source trace IDs preserved.
 */
export function dedup(traces: TraceRecord[]): EvalExample[] {
  const groups = new Map<string, { canonical: TraceRecord; traceIds: string[] }>();

  for (const trace of traces) {
    const hash = contentHash(trace);
    const existing = groups.get(hash);
    if (existing) {
      existing.traceIds.push(trace.traceId);
    } else {
      groups.set(hash, { canonical: trace, traceIds: [trace.traceId] });
    }
  }

  const examples: EvalExample[] = [];
  for (const [hash, group] of groups) {
    examples.push({
      id: hash,
      input: group.canonical.input,
      expectedFailureType: group.canonical.failureType,
      profileId: group.canonical.profileId,
      cluster: clusterLabel(group.canonical.failureType),
      sourceTraceIds: group.traceIds,
    });
  }

  return examples;
}

/**
 * Strips any secret-like values from metadata.
 * Ensures exported artifacts never contain credentials.
 */
export function sanitizeMetadata(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  const secretPatterns = [
    /api[_-]?key/i,
    /secret/i,
    /token/i,
    /password/i,
    /credential/i,
    /auth/i,
    /private[_-]?key/i,
  ];

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (secretPatterns.some((p) => p.test(key))) {
      sanitized[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      sanitized[key] = sanitizeMetadata(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
