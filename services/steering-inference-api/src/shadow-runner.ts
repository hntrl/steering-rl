import type { ModelAdapter, ProviderRequest, ProviderResponse } from "./providers/model-adapter.js";

export interface ShadowTrafficSample {
  request_id: string;
  original_request: ProviderRequest;
  timestamp: string;
}

export interface ShadowExecutionResult {
  request_id: string;
  champion_response: ProviderResponse;
  challenger_response: ProviderResponse | null;
  challenger_error: string | null;
  champion_latency_ms: number;
  challenger_latency_ms: number | null;
  timestamp: string;
}

export interface ShadowRunnerConfig {
  champion_adapter: ModelAdapter;
  challenger_adapter: ModelAdapter;
  sample_rate?: number;
  timeout_ms?: number;
  on_error?: (error: unknown, context: string) => void;
}

export interface ShadowRunnerEvent {
  type: "shadow_execution_complete" | "shadow_execution_error" | "shadow_sample_skipped";
  request_id: string;
  timestamp: string;
  detail: Record<string, unknown>;
}

export type ShadowRunnerListener = (event: ShadowRunnerEvent) => void;

const DEFAULT_SAMPLE_RATE = 1.0;
const DEFAULT_TIMEOUT_MS = 30_000;

export class ShadowRunner {
  private readonly config: Required<Pick<ShadowRunnerConfig, "sample_rate" | "timeout_ms">> &
    ShadowRunnerConfig;
  private readonly listeners: ShadowRunnerListener[] = [];

  constructor(config: ShadowRunnerConfig) {
    this.config = {
      ...config,
      sample_rate: config.sample_rate ?? DEFAULT_SAMPLE_RATE,
      timeout_ms: config.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    };
  }

  on(listener: ShadowRunnerListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private emit(event: ShadowRunnerEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  shouldSample(): boolean {
    return Math.random() < this.config.sample_rate;
  }

  async execute(sample: ShadowTrafficSample): Promise<ShadowExecutionResult> {
    if (!this.shouldSample()) {
      this.emit({
        type: "shadow_sample_skipped",
        request_id: sample.request_id,
        timestamp: new Date().toISOString(),
        detail: { reason: "below_sample_rate" },
      });
      return {
        request_id: sample.request_id,
        champion_response: await this.runChampion(sample.original_request),
        challenger_response: null,
        challenger_error: "skipped_by_sample_rate",
        champion_latency_ms: 0,
        challenger_latency_ms: null,
        timestamp: new Date().toISOString(),
      };
    }

    const championStart = Date.now();
    const championResponse = await this.runChampion(sample.original_request);
    const championLatency = Date.now() - championStart;

    let challengerResponse: ProviderResponse | null = null;
    let challengerError: string | null = null;
    let challengerLatency: number | null = null;

    try {
      const challengerStart = Date.now();
      challengerResponse = await this.runChallengerWithTimeout(sample.original_request);
      challengerLatency = Date.now() - challengerStart;
    } catch (err: unknown) {
      challengerError = err instanceof Error ? err.message : String(err);
      if (this.config.on_error) {
        this.config.on_error(err, `challenger_execution:${sample.request_id}`);
      }
      this.emit({
        type: "shadow_execution_error",
        request_id: sample.request_id,
        timestamp: new Date().toISOString(),
        detail: { error: challengerError },
      });
    }

    const result: ShadowExecutionResult = {
      request_id: sample.request_id,
      champion_response: championResponse,
      challenger_response: challengerResponse,
      challenger_error: challengerError,
      champion_latency_ms: championLatency,
      challenger_latency_ms: challengerLatency,
      timestamp: new Date().toISOString(),
    };

    this.emit({
      type: "shadow_execution_complete",
      request_id: sample.request_id,
      timestamp: new Date().toISOString(),
      detail: {
        champion_latency_ms: championLatency,
        challenger_latency_ms: challengerLatency,
        challenger_succeeded: challengerResponse !== null,
      },
    });

    return result;
  }

  async executeBatch(samples: ShadowTrafficSample[]): Promise<ShadowExecutionResult[]> {
    const results: ShadowExecutionResult[] = [];
    for (const sample of samples) {
      results.push(await this.execute(sample));
    }
    return results;
  }

  private async runChampion(request: ProviderRequest): Promise<ProviderResponse> {
    return this.config.champion_adapter.chatCompletion(request);
  }

  private async runChallengerWithTimeout(request: ProviderRequest): Promise<ProviderResponse> {
    return new Promise<ProviderResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Challenger execution timed out after ${this.config.timeout_ms}ms`));
      }, this.config.timeout_ms);

      this.config.challenger_adapter
        .chatCompletion(request)
        .then((response) => {
          clearTimeout(timer);
          resolve(response);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  getUserVisibleResponse(result: ShadowExecutionResult): ProviderResponse {
    return result.champion_response;
  }
}
