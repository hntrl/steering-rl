import {
  type TraceMetadata,
  type RunMode,
  type ValidationResult,
  validateMetadata,
  sanitizeMetadata,
  buildTagsWithSuite,
  validateTagSet,
} from "./metadata-validator.js";

export interface MiddlewareConfig {
  mode: RunMode;
  warnOnly?: boolean;
  onTrace?: (trace: TracePayload) => void | Promise<void>;
  onValidationError?: (result: ValidationResult) => void;
}

export interface TracePayload {
  metadata: Record<string, unknown>;
  tags: string[];
  project?: string;
}

export interface MiddlewareResult {
  allowed: boolean;
  trace: TracePayload | null;
  validation: ValidationResult;
}

export function createTracingMiddleware(config: MiddlewareConfig) {
  const { mode, warnOnly = false, onTrace, onValidationError } = config;

  return async function processTrace(
    metadata: Partial<TraceMetadata>,
    options?: { suite?: string; candidate?: string; release?: string }
  ): Promise<MiddlewareResult> {
    const validation = validateMetadata(metadata, mode);

    if (!validation.valid) {
      onValidationError?.(validation);

      if (!warnOnly && (mode === "eval" || mode === "prod")) {
        return {
          allowed: false,
          trace: null,
          validation,
        };
      }
    }

    const sanitized = sanitizeMetadata(
      metadata as Record<string, unknown>
    );

    const tags = buildTagsWithSuite(
      metadata,
      options?.suite,
      options?.candidate,
      options?.release
    );

    const tagValidation = validateTagSet(tags);
    if (!tagValidation.valid) {
      validation.errors.push(...tagValidation.errors);
      validation.warnings.push(...tagValidation.warnings);

      if (!warnOnly && (mode === "eval" || mode === "prod")) {
        onValidationError?.(validation);
        return {
          allowed: false,
          trace: null,
          validation,
        };
      }
    }

    if (tagValidation.warnings.length > 0) {
      validation.warnings.push(...tagValidation.warnings);
    }

    const project = resolveProject(metadata.env ?? "dev", mode);

    const trace: TracePayload = {
      metadata: sanitized,
      tags,
      project,
    };

    if (onTrace) {
      await onTrace(trace);
    }

    const finalValidation: ValidationResult = warnOnly
      ? {
          valid: true,
          errors: [],
          warnings: [...validation.warnings, ...validation.errors],
        }
      : {
          valid: validation.errors.length === 0,
          errors: validation.errors,
          warnings: validation.warnings,
        };

    return {
      allowed: true,
      trace,
      validation: finalValidation,
    };
  };
}

function resolveProject(env: string, mode: RunMode): string {
  if (mode === "eval") {
    return `steer-evals-${env}`;
  }
  return `steer-prod-${env}`;
}
