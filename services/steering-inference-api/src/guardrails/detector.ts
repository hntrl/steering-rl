/**
 * Guardrail detector module.
 *
 * Detects degeneration signals in model output tokens:
 *   - repetition loops (n-gram and substring)
 *   - language shift (unexpected script/charset drift)
 *   - entropy collapse (token distribution narrowing)
 */

export interface DetectorConfig {
  /** Minimum n-gram size for repetition detection. */
  ngramSize: number;
  /** Fraction of output that must be repeated n-grams to trigger. */
  repetitionThreshold: number;
  /** Maximum allowed fraction of non-Latin characters before language_shift triggers. */
  languageShiftThreshold: number;
  /** Minimum unique-token ratio below which entropy collapse triggers. */
  entropyCollapseThreshold: number;
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  ngramSize: 3,
  repetitionThreshold: 0.4,
  languageShiftThreshold: 0.3,
  entropyCollapseThreshold: 0.1,
};

export interface DetectionResult {
  triggered: boolean;
  signals: {
    repetition: boolean;
    language_shift: boolean;
    entropy_collapse: boolean;
  };
  details: Record<string, number>;
}

/**
 * Tokenise text into whitespace-separated words.
 */
function tokenize(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Detect n-gram repetition loops.
 *
 * Returns the fraction of tokens that belong to repeated n-gram sequences.
 */
function detectRepetition(
  tokens: string[],
  ngramSize: number,
): number {
  if (tokens.length < ngramSize * 2) return 0;

  const ngramCounts = new Map<string, number>();
  for (let i = 0; i <= tokens.length - ngramSize; i++) {
    const gram = tokens.slice(i, i + ngramSize).join(" ");
    ngramCounts.set(gram, (ngramCounts.get(gram) ?? 0) + 1);
  }

  let repeatedGramTokens = 0;
  for (const [, count] of ngramCounts) {
    if (count > 1) {
      repeatedGramTokens += count * ngramSize;
    }
  }

  return Math.min(1, repeatedGramTokens / tokens.length);
}

/**
 * Detect language/script shift.
 *
 * Returns the fraction of characters that fall outside Basic Latin + Latin-1 Supplement.
 */
function detectLanguageShift(text: string): number {
  if (text.length === 0) return 0;

  const stripped = text.replace(/\s+/g, "");
  if (stripped.length === 0) return 0;

  let nonLatinCount = 0;
  for (const char of stripped) {
    const code = char.codePointAt(0)!;
    // Basic Latin (0x0000-0x007F) + Latin-1 Supplement (0x0080-0x00FF)
    // Also allow common punctuation / digits
    if (code > 0x00ff) {
      nonLatinCount++;
    }
  }

  return nonLatinCount / stripped.length;
}

/**
 * Detect entropy collapse.
 *
 * Returns the unique-token ratio. Low values indicate collapse.
 */
function detectEntropyCollapse(tokens: string[]): number {
  if (tokens.length === 0) return 1;
  const unique = new Set(tokens);
  return unique.size / tokens.length;
}

/**
 * Run all detectors on a text output and return combined result.
 */
export function detect(
  text: string,
  config: DetectorConfig = DEFAULT_DETECTOR_CONFIG,
): DetectionResult {
  const tokens = tokenize(text);

  const repetitionScore = detectRepetition(tokens, config.ngramSize);
  const languageShiftScore = detectLanguageShift(text);
  const uniqueRatio = detectEntropyCollapse(tokens);

  const repetition = repetitionScore >= config.repetitionThreshold;
  const language_shift = languageShiftScore >= config.languageShiftThreshold;
  const entropy_collapse = uniqueRatio <= config.entropyCollapseThreshold;

  return {
    triggered: repetition || language_shift || entropy_collapse,
    signals: {
      repetition,
      language_shift,
      entropy_collapse,
    },
    details: {
      repetition_score: repetitionScore,
      language_shift_score: languageShiftScore,
      unique_token_ratio: uniqueRatio,
    },
  };
}
