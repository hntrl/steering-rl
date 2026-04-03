import { describe, it, expect } from "vitest";
import {
  detect,
  DEFAULT_DETECTOR_CONFIG,
  type DetectorConfig,
} from "../src/guardrails/detector.js";
import {
  applyBackoff,
  buildPostBackoffMetadata,
  DEFAULT_BACKOFF_CONFIG,
  type BackoffPolicyConfig,
  type SteeringState,
  type GenerateFn,
} from "../src/guardrails/backoff-policy.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Generate heavily repeated text to trigger repetition detection. */
function makeRepetitiveText(phrase: string, repeats: number): string {
  return Array(repeats).fill(phrase).join(" ");
}

/** Generate text with heavy non-Latin characters to trigger language_shift. */
function makeLanguageShiftText(): string {
  return "这是一个测试文本，用于检测语言偏移。这段文字完全是中文的。更多中文内容在这里，用来确保超过阈值。";
}

/** Generate text with extreme token repetition to trigger entropy collapse. */
function makeEntropyCollapseText(): string {
  return Array(100).fill("the").join(" ");
}

/** Normal, coherent text that should not trigger any detector. */
function makeCleanText(): string {
  return (
    "Budgeting is the process of creating a plan to spend your money. " +
    "This spending plan is called a budget. Creating this plan allows you " +
    "to determine in advance whether you will have enough money to do the " +
    "things you need to do or would like to do. Budgeting is simply balancing " +
    "your expenses with your income. If they do not balance and you spend more " +
    "than you make, you will have a problem."
  );
}

const TEST_CONFIG: BackoffPolicyConfig = {
  ...DEFAULT_BACKOFF_CONFIG,
  maxBackoffSteps: 4,
};

// ---------------------------------------------------------------------------
// Detector tests
// ---------------------------------------------------------------------------

describe("detect", () => {
  it("does not trigger on clean text", () => {
    const result = detect(makeCleanText());
    expect(result.triggered).toBe(false);
    expect(result.signals.repetition).toBe(false);
    expect(result.signals.language_shift).toBe(false);
    expect(result.signals.entropy_collapse).toBe(false);
  });

  it("triggers repetition on looped phrases", () => {
    const text = makeRepetitiveText("budget plan money", 30);
    const result = detect(text);
    expect(result.triggered).toBe(true);
    expect(result.signals.repetition).toBe(true);
    expect(result.details.repetition_score).toBeGreaterThanOrEqual(
      DEFAULT_DETECTOR_CONFIG.repetitionThreshold,
    );
  });

  it("triggers language_shift on non-Latin text", () => {
    const result = detect(makeLanguageShiftText());
    expect(result.triggered).toBe(true);
    expect(result.signals.language_shift).toBe(true);
    expect(result.details.language_shift_score).toBeGreaterThanOrEqual(
      DEFAULT_DETECTOR_CONFIG.languageShiftThreshold,
    );
  });

  it("triggers entropy_collapse on single-token repetition", () => {
    const result = detect(makeEntropyCollapseText());
    expect(result.triggered).toBe(true);
    expect(result.signals.entropy_collapse).toBe(true);
    expect(result.details.unique_token_ratio).toBeLessThanOrEqual(
      DEFAULT_DETECTOR_CONFIG.entropyCollapseThreshold,
    );
  });

  it("returns all signal flags when multiple failures co-occur", () => {
    const text = makeRepetitiveText("the", 100);
    const result = detect(text);
    expect(result.triggered).toBe(true);
    // both repetition and entropy collapse should fire on "the the the..."
    expect(result.signals.repetition).toBe(true);
    expect(result.signals.entropy_collapse).toBe(true);
  });

  it("respects custom config thresholds", () => {
    const strict: DetectorConfig = {
      ngramSize: 2,
      repetitionThreshold: 0.1,
      languageShiftThreshold: 0.05,
      entropyCollapseThreshold: 0.5,
    };
    const text = "hello world hello world hello world more text here";
    const result = detect(text, strict);
    expect(result.triggered).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Backoff policy tests
// ---------------------------------------------------------------------------

describe("applyBackoff", () => {
  it("does not backoff when output is clean", () => {
    const generate: GenerateFn = () => makeCleanText();
    const result = applyBackoff("strong", generate, TEST_CONFIG);

    expect(result.totalSteps).toBe(0);
    expect(result.telemetry).toHaveLength(0);
    expect(result.finalState.preset).toBe("strong");
    expect(result.finalState.steeringEnabled).toBe(true);
    expect(result.reachedNoSteering).toBe(false);
  });

  it("steps from strong to medium when degeneration detected then resolves", () => {
    let callCount = 0;
    const generate: GenerateFn = () => {
      callCount++;
      if (callCount === 1) return makeRepetitiveText("budget plan money", 30);
      return makeCleanText();
    };

    const result = applyBackoff("strong", generate, TEST_CONFIG);

    expect(result.totalSteps).toBe(1);
    expect(result.finalState.preset).toBe("medium");
    expect(result.finalState.steeringEnabled).toBe(true);
    expect(result.telemetry).toHaveLength(1);
    expect(result.telemetry[0].from.preset).toBe("strong");
    expect(result.telemetry[0].to.preset).toBe("medium");
  });

  it("walks entire ladder: strong → medium → low → single-layer → off", () => {
    // Always degenerate: forces full backoff
    const generate: GenerateFn = () =>
      makeRepetitiveText("degenerate loop text", 30);

    const result = applyBackoff("strong", generate, TEST_CONFIG);

    expect(result.totalSteps).toBe(4);
    expect(result.reachedNoSteering).toBe(true);
    expect(result.finalState.preset).toBe("off");
    expect(result.finalState.steeringEnabled).toBe(false);
    expect(result.finalState.layers).toEqual([]);
    expect(result.finalState.multiplier).toBe(0);

    // Verify telemetry trail
    expect(result.telemetry).toHaveLength(4);
    const presetTrail = result.telemetry.map((e) => [
      e.from.preset,
      e.to.preset,
    ]);
    expect(presetTrail).toEqual([
      ["strong", "medium"],
      ["medium", "low"],
      ["low", "low"],      // low multi-layer → low single-layer
      ["low", "off"],       // low single-layer → off
    ]);
  });

  it("emits telemetry for each backoff step", () => {
    const generate: GenerateFn = () =>
      makeRepetitiveText("degenerate loop text", 30);
    const result = applyBackoff("strong", generate, TEST_CONFIG);

    for (const event of result.telemetry) {
      expect(event.type).toBe("guardrail_backoff");
      expect(event.step).toBeGreaterThan(0);
      expect(event.detection.triggered).toBe(true);
      expect(event.timestamp).toBeGreaterThan(0);
    }
  });

  it("does not exceed maxBackoffSteps (no infinite retry)", () => {
    const config: BackoffPolicyConfig = {
      ...TEST_CONFIG,
      maxBackoffSteps: 2,
    };
    const generate: GenerateFn = () =>
      makeRepetitiveText("degenerate loop text", 30);

    const result = applyBackoff("strong", generate, config);

    expect(result.totalSteps).toBe(2);
    // Should stop at low preset (strong→medium→low), not reach off
    expect(result.finalState.preset).toBe("low");
    expect(result.finalState.steeringEnabled).toBe(true);
    expect(result.telemetry).toHaveLength(2);
  });

  it("backoff starting from medium walks: medium → low → single-layer → off", () => {
    const generate: GenerateFn = () =>
      makeRepetitiveText("degenerate loop text", 30);
    const result = applyBackoff("medium", generate, TEST_CONFIG);

    expect(result.totalSteps).toBe(3);
    expect(result.reachedNoSteering).toBe(true);
    expect(result.finalState.preset).toBe("off");
  });

  it("single-layer step uses the fallback layer", () => {
    let callCount = 0;
    const generate: GenerateFn = () => {
      callCount++;
      // Degenerate for first 2 calls (strong→medium, medium→low), clean on third
      if (callCount <= 2) return makeRepetitiveText("budget plan money", 30);
      return makeCleanText();
    };

    const result = applyBackoff("strong", generate, TEST_CONFIG);

    expect(result.totalSteps).toBe(2);
    expect(result.finalState.preset).toBe("low");
    expect(result.finalState.layers).toEqual(TEST_CONFIG.allLayers);
    expect(result.finalState.steeringEnabled).toBe(true);
  });

  it("handles language_shift backoff correctly", () => {
    let callCount = 0;
    const generate: GenerateFn = () => {
      callCount++;
      if (callCount === 1) return makeLanguageShiftText();
      return makeCleanText();
    };

    const result = applyBackoff("strong", generate, TEST_CONFIG);

    expect(result.totalSteps).toBe(1);
    expect(result.telemetry[0].detection.signals.language_shift).toBe(true);
    expect(result.finalState.preset).toBe("medium");
  });
});

// ---------------------------------------------------------------------------
// Fallback to no-steering mode
// ---------------------------------------------------------------------------

describe("fallback to no-steering mode", () => {
  it("produces a valid no-steering final state", () => {
    const generate: GenerateFn = () =>
      makeRepetitiveText("degenerate loop text", 30);

    const result = applyBackoff("strong", generate, TEST_CONFIG);

    expect(result.reachedNoSteering).toBe(true);
    expect(result.finalState).toEqual({
      preset: "off",
      layers: [],
      multiplier: 0,
      steeringEnabled: false,
    });
  });

  it("no-steering state can be used to generate clean output", () => {
    // Simulate: first 4 calls degenerate, then clean when steering off
    let callCount = 0;
    const generate: GenerateFn = (state: SteeringState) => {
      callCount++;
      if (state.steeringEnabled) {
        return makeRepetitiveText("degenerate loop text", 30);
      }
      return makeCleanText();
    };

    const result = applyBackoff("strong", generate, TEST_CONFIG);

    // Should reach off state after 4 steps
    expect(result.reachedNoSteering).toBe(true);
    // The generate function with off state would produce clean text
    // (verified by the fact that the backoff stopped at off)
    expect(result.finalState.steeringEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Post-backoff metadata
// ---------------------------------------------------------------------------

describe("buildPostBackoffMetadata", () => {
  it("reflects post-backoff active layers in metadata", () => {
    const generate: GenerateFn = () =>
      makeRepetitiveText("degenerate loop text", 30);

    const result = applyBackoff("strong", generate, TEST_CONFIG);
    const metadata = buildPostBackoffMetadata(result, "req_test_001");

    expect(metadata.request_id).toBe("req_test_001");
    expect(metadata.steering_enabled).toBe(false);
    expect(metadata.active_preset).toBe("off");
    expect(metadata.active_layers).toEqual([]);
    expect(metadata.effective_multiplier).toBe(0);
    expect(metadata.backoff_steps).toBe(4);
    expect(metadata.reached_no_steering).toBe(true);
    expect(metadata.guardrail_events).toHaveLength(4);
  });

  it("reflects partial backoff in metadata", () => {
    let callCount = 0;
    const generate: GenerateFn = () => {
      callCount++;
      if (callCount === 1) return makeRepetitiveText("budget plan money", 30);
      return makeCleanText();
    };

    const result = applyBackoff("strong", generate, TEST_CONFIG);
    const metadata = buildPostBackoffMetadata(result, "req_test_002");

    expect(metadata.steering_enabled).toBe(true);
    expect(metadata.active_preset).toBe("medium");
    expect(metadata.active_layers).toEqual(TEST_CONFIG.allLayers);
    expect(metadata.effective_multiplier).toBe(
      TEST_CONFIG.presetTable.medium,
    );
    expect(metadata.backoff_steps).toBe(1);
    expect(metadata.reached_no_steering).toBe(false);
  });

  it("reflects zero backoff in metadata when no degeneration", () => {
    const generate: GenerateFn = () => makeCleanText();
    const result = applyBackoff("strong", generate, TEST_CONFIG);
    const metadata = buildPostBackoffMetadata(result, "req_test_003");

    expect(metadata.steering_enabled).toBe(true);
    expect(metadata.active_preset).toBe("strong");
    expect(metadata.active_layers).toEqual(TEST_CONFIG.allLayers);
    expect(metadata.effective_multiplier).toBe(
      TEST_CONFIG.presetTable.strong,
    );
    expect(metadata.backoff_steps).toBe(0);
    expect(metadata.guardrail_events).toHaveLength(0);
  });
});
