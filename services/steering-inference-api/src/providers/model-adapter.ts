/**
 * Provider adapter for OpenAI-compatible model runtimes.
 *
 * Executes chat completion requests against a live inference backend while
 * preserving the OpenAI request/response shape. Steering parameters are
 * forwarded as extra body fields that the runtime is expected to honour.
 *
 * Security: raw prompts and bearer tokens are never written to runtime logs.
 */

export interface ProviderMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface SteeringParams {
  concept?: string;
  preset?: string;
  layers: number[];
  multiplier: number;
  profile_id: string;
}

export interface ProviderRequest {
  model: string;
  messages: ProviderMessage[];
  temperature?: number;
  max_tokens?: number;
  steering?: SteeringParams;
}

export interface ProviderChoice {
  index: number;
  message: ProviderMessage;
  finish_reason: "stop" | "length" | "content_filter";
}

export interface ProviderUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ProviderResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ProviderChoice[];
  usage: ProviderUsage;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly retryable: boolean,
    public readonly providerCode: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ModelAdapter {
  chatCompletion(request: ProviderRequest): Promise<ProviderResponse>;
}

/**
 * HTTP-based adapter that calls an OpenAI-compatible inference endpoint.
 */
export class HttpModelAdapter implements ModelAdapter {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(opts?: { baseUrl?: string; apiKey?: string; timeoutMs?: number }) {
    this.baseUrl =
      opts?.baseUrl ??
      process.env.INFERENCE_BASE_URL ??
      "http://localhost:8000";
    this.apiKey = opts?.apiKey ?? process.env.INFERENCE_API_KEY;
    this.timeoutMs = opts?.timeoutMs ?? 30_000;
  }

  async chatCompletion(request: ProviderRequest): Promise<ProviderResponse> {
    const url = `${this.baseUrl}/v1/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
    if (request.steering) {
      body.steering = request.steering;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Provider connection failed";
      throw new ProviderError(
        `Upstream provider unreachable: ${message}`,
        502,
        true,
        "provider_connection_error",
      );
    }

    if (!res.ok) {
      const retryable = res.status >= 500 || res.status === 429;
      let errorMessage = `Provider returned HTTP ${res.status}`;
      try {
        const errBody = (await res.json()) as Record<string, unknown>;
        if (
          errBody.error &&
          typeof errBody.error === "object" &&
          (errBody.error as Record<string, unknown>).message
        ) {
          errorMessage = String(
            (errBody.error as Record<string, unknown>).message,
          );
        }
      } catch {
        // non-JSON error body — use status-based message
      }

      throw new ProviderError(
        errorMessage,
        mapProviderStatus(res.status),
        retryable,
        mapProviderCode(res.status),
      );
    }

    const data = (await res.json()) as ProviderResponse;
    return data;
  }
}

function mapProviderStatus(upstream: number): number {
  if (upstream === 429) return 529;
  if (upstream >= 500) return 502;
  if (upstream === 401 || upstream === 403) return 502;
  return 502;
}

function mapProviderCode(upstream: number): string {
  if (upstream === 429) return "provider_rate_limited";
  if (upstream >= 500) return "provider_internal_error";
  if (upstream === 401 || upstream === 403) return "provider_auth_error";
  return "provider_error";
}
