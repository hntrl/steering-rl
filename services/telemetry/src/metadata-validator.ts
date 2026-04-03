export type RunMode = "eval" | "prod" | "dev";

export interface TraceMetadata {
  env: string;
  agent?: string;
  base_model: string;
  base_model_revision?: string;
  profile_id: string;
  vector_bundle_id: string;
  layers: number[];
  fallback_layer?: number;
  preset: string;
  multiplier?: number;
  concept?: string;
  request_id?: string;
  thread_id?: string;
  dataset_version?: string;
  git_sha?: string;
  judge_bundle?: string;
  latency_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  degenerate?: boolean;
  language_shift?: boolean;
  [key: string]: unknown;
}

export interface TagSet {
  model: string;
  profile: string;
  preset: string;
  suite?: string;
  concept?: string;
  candidate?: string;
  release?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const REQUIRED_METADATA_FIELDS: (keyof TraceMetadata)[] = [
  "profile_id",
  "vector_bundle_id",
  "base_model",
  "preset",
  "layers",
  "env",
];

const SECRET_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /token/i,
  /credential/i,
  /private[_-]?key/i,
  /auth[_-]?header/i,
  /bearer/i,
  /session[_-]?id/i,
  /cookie/i,
];

const SECRET_VALUE_PATTERNS = [
  /^sk-[a-zA-Z0-9]+/,
  /^lsv2_[a-zA-Z0-9]+/,
  /^ghp_[a-zA-Z0-9]+/,
  /^xox[bprs]-[a-zA-Z0-9]+/,
  /^eyJ[a-zA-Z0-9]+/,
];

export function validateMetadata(
  metadata: Partial<TraceMetadata>,
  mode: RunMode
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const field of REQUIRED_METADATA_FIELDS) {
    const value = metadata[field];
    if (value === undefined || value === null || value === "") {
      const msg = `Missing required metadata field: ${field}`;
      if (mode === "eval" || mode === "prod") {
        errors.push(msg);
      } else {
        warnings.push(msg);
      }
    }
  }

  if (
    metadata.layers !== undefined &&
    metadata.layers !== null &&
    !Array.isArray(metadata.layers)
  ) {
    errors.push("Field 'layers' must be an array of numbers");
  }

  if (
    Array.isArray(metadata.layers) &&
    metadata.layers.length > 0 &&
    !metadata.layers.every((l) => typeof l === "number")
  ) {
    errors.push("Field 'layers' must contain only numbers");
  }

  if (
    metadata.preset !== undefined &&
    !["low", "medium", "strong"].includes(metadata.preset)
  ) {
    warnings.push(
      `Preset '${metadata.preset}' is not a standard value (low|medium|strong)`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function sanitizeMetadata(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (isSecretKey(key)) {
      sanitized[key] = "[REDACTED]";
      continue;
    }

    if (typeof value === "string" && isSecretValue(value)) {
      sanitized[key] = "[REDACTED]";
      continue;
    }

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      sanitized[key] = sanitizeMetadata(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

function isSecretKey(key: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(key));
}

function isSecretValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

export function buildTags(metadata: Partial<TraceMetadata>): string[] {
  const tags: string[] = [];

  if (metadata.base_model) {
    tags.push(`model:${metadata.base_model}`);
  }

  if (metadata.profile_id) {
    tags.push(`profile:${metadata.profile_id}`);
  }

  if (metadata.preset) {
    tags.push(`preset:${metadata.preset}`);
  }

  if (metadata.concept) {
    tags.push(`concept:${metadata.concept}`);
  }

  return tags;
}

export function buildTagsWithSuite(
  metadata: Partial<TraceMetadata>,
  suite?: string,
  candidate?: string,
  release?: string
): string[] {
  const tags = buildTags(metadata);

  if (suite) {
    tags.push(`suite:${suite}`);
  }

  if (candidate) {
    tags.push(`candidate:${candidate}`);
  }

  if (release) {
    tags.push(`release:${release}`);
  }

  return tags;
}

export function validateTagSet(tags: string[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const requiredPrefixes = ["model:", "profile:", "preset:"];
  for (const prefix of requiredPrefixes) {
    if (!tags.some((t) => t.startsWith(prefix))) {
      errors.push(`Missing required tag with prefix '${prefix}'`);
    }
  }

  const validPrefixes = [
    "model:",
    "profile:",
    "preset:",
    "concept:",
    "suite:",
    "candidate:",
    "release:",
  ];
  for (const tag of tags) {
    if (!validPrefixes.some((p) => tag.startsWith(p))) {
      warnings.push(`Tag '${tag}' does not match known naming conventions`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
