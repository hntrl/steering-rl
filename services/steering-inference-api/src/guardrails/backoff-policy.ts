/**
 * Backoff policy for runtime guardrails.
 *
 * Applies a safe backoff ladder within a single request context:
 *   strong → medium → single-layer → off (no-steering)
 *
 * Constraints:
 *   - Backoff applies only to the active request context (no global mutation).
 *   - No infinite retry loops (bounded step count).
 *   - Emits telemetry for each backoff step.
 */

import { detect, type DetectorConfig, type DetectionResult } from "./detector.js";

export type Preset = "strong" | "medium" | "low";

export interface SteeringState {
  preset: Preset | "off";
  layers: number[];
  multiplier: number;
  steeringEnabled: boolean;
}

export interface PresetTable {
  low: number;
  medium: number;
  strong: number;
}

export interface BackoffPolicyConfig {
  presetTable: PresetTable;
  allLayers: number[];
  fallbackLayer: number;
  detectorConfig?: DetectorConfig;
  maxBackoffSteps: number;
}

export const DEFAULT_PRESET_TABLE: PresetTable = {
  low: 0.12,
  medium: 0.22,
  strong: 0.34,
};

export const DEFAULT_BACKOFF_CONFIG: BackoffPolicyConfig = {
  presetTable: DEFAULT_PRESET_TABLE,
  allLayers: [23, 29, 35, 41, 47],
  fallbackLayer: 41,
  maxBackoffSteps: 4,
};

export interface TelemetryEvent {
  type: "guardrail_backoff";
  step: number;
  from: SteeringState;
  to: SteeringState;
  detection: DetectionResult;
  timestamp: number;
}

export interface BackoffResult {
  finalState: SteeringState;
  telemetry: TelemetryEvent[];
  totalSteps: number;
  reachedNoSteering: boolean;
}

/**
 * Ordered backoff ladder. Each function returns the next less-aggressive state.
 */
function nextState(
  current: SteeringState,
  config: BackoffPolicyConfig,
): SteeringState | null {
  const { presetTable, fallbackLayer } = config;

  if (!current.steeringEnabled || current.preset === "off") {
    return null;
  }

  // strong → medium (keep all layers)
  if (current.preset === "strong") {
    return {
      preset: "medium",
      layers: [...current.layers],
      multiplier: presetTable.medium,
      steeringEnabled: true,
    };
  }

  // medium → low (keep all layers)
  if (current.preset === "medium") {
    return {
      preset: "low",
      layers: [...current.layers],
      multiplier: presetTable.low,
      steeringEnabled: true,
    };
  }

  // low with multiple layers → low single-layer (fallback layer)
  if (current.preset === "low" && current.layers.length > 1) {
    return {
      preset: "low",
      layers: [fallbackLayer],
      multiplier: presetTable.low,
      steeringEnabled: true,
    };
  }

  // low single-layer → off (no steering)
  if (current.preset === "low" && current.layers.length <= 1) {
    return {
      preset: "off",
      layers: [],
      multiplier: 0,
      steeringEnabled: false,
    };
  }

  return null;
}

export type GenerateFn = (state: SteeringState) => string;

/**
 * Execute backoff policy for a single request.
 *
 * Takes a generate function that produces model output for a given steering state,
 * detects degeneration, and applies backoff steps until the output is safe or
 * steering is fully disabled.
 *
 * @param initialPreset - Starting preset level
 * @param generate - Function that produces output text for a given steering state
 * @param config - Backoff policy configuration
 * @returns BackoffResult with final state, telemetry trail, and step count
 */
export function applyBackoff(
  initialPreset: Preset,
  generate: GenerateFn,
  config: BackoffPolicyConfig = DEFAULT_BACKOFF_CONFIG,
): BackoffResult {
  const telemetry: TelemetryEvent[] = [];

  let currentState: SteeringState = {
    preset: initialPreset,
    layers: [...config.allLayers],
    multiplier: config.presetTable[initialPreset],
    steeringEnabled: true,
  };

  let step = 0;

  while (step < config.maxBackoffSteps) {
    const output = generate(currentState);
    const detection = detect(output, config.detectorConfig);

    if (!detection.triggered) {
      break;
    }

    const next = nextState(currentState, config);
    if (next === null) {
      break;
    }

    step++;

    telemetry.push({
      type: "guardrail_backoff",
      step,
      from: { ...currentState },
      to: { ...next },
      detection,
      timestamp: Date.now(),
    });

    currentState = next;
  }

  return {
    finalState: currentState,
    telemetry,
    totalSteps: step,
    reachedNoSteering: !currentState.steeringEnabled,
  };
}

/**
 * Build run metadata reflecting post-backoff state.
 * This should be attached to the final response trace.
 */
export function buildPostBackoffMetadata(
  result: BackoffResult,
  requestId: string,
): Record<string, unknown> {
  return {
    request_id: requestId,
    steering_enabled: result.finalState.steeringEnabled,
    active_preset: result.finalState.preset,
    active_layers: result.finalState.layers,
    effective_multiplier: result.finalState.multiplier,
    backoff_steps: result.totalSteps,
    reached_no_steering: result.reachedNoSteering,
    guardrail_events: result.telemetry.map((e) => ({
      step: e.step,
      from_preset: e.from.preset,
      to_preset: e.to.preset,
      from_layers: e.from.layers,
      to_layers: e.to.layers,
      signals: e.detection.signals,
    })),
  };
}
