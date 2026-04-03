import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import express from "express";
import { createApp } from "../src/app.js";
import { ProfileRegistry, type SteeringProfile } from "../src/profiles/registry.js";
import {
  type ModelAdapter,
  type ProviderRequest,
  type ProviderResponse,
  ProviderError,
} from "../src/providers/model-adapter.js";

const TEST_PROFILE: SteeringProfile = {
  profile_id: "steer-gemma3-default-v12",
  base_model: "gemma-3-27b-it",
  base_model_revision: "2026-03-15",
  layers: [23, 29, 35, 41, 47],
  fallback_layer: 41,
  vector_bundle_id: "vec-bundle-2026-04-01-rc2",
  preset_table: {
    low: 0.12,
    medium: 0.22,
    strong: 0.34,
  },
  judge_bundle: "judge-v4",
  created_at: "2026-04-02T00:00:00Z",
};

function makeApp(profiles?: SteeringProfile[]): express.Express {
  const registry = new ProfileRegistry(profiles ?? [TEST_PROFILE]);
  return createApp(registry);
}

function makeProviderResponse(overrides: Partial<ProviderResponse> = {}): ProviderResponse {
  return {
    id: "chatcmpl-provider-test-001",
    object: "chat.completion",
    created: 1714000000,
    model: "gemma-3-27b-it",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Provider response content" },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 50,
      completion_tokens: 20,
      total_tokens: 70,
    },
    ...overrides,
  };
}

function makeMockAdapter(
  impl?: (req: ProviderRequest) => Promise<ProviderResponse>,
): ModelAdapter {
  return {
    chatCompletion: vi.fn(impl ?? (async () => makeProviderResponse())),
  };
}

function makeAppWithAdapter(
  adapter: ModelAdapter,
  profiles?: SteeringProfile[],
): express.Express {
  const registry = new ProfileRegistry(profiles ?? [TEST_PROFILE]);
  return createApp({ registry, adapter });
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    model: "gemma-3-27b-it",
    messages: [{ role: "user", content: "Hello" }],
    ...overrides,
  };
}

describe("POST /v1/chat/completions", () => {
  describe("baseline OpenAI-compatible responses", () => {
    it("returns a valid chat completion for a simple request", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send(validPayload())
        .expect(200);

      expect(res.body).toHaveProperty("id");
      expect(res.body.id).toMatch(/^chatcmpl-/);
      expect(res.body).toHaveProperty("object", "chat.completion");
      expect(res.body).toHaveProperty("created");
      expect(typeof res.body.created).toBe("number");
      expect(res.body).toHaveProperty("model", "gemma-3-27b-it");
      expect(res.body).toHaveProperty("choices");
      expect(res.body.choices).toHaveLength(1);
      expect(res.body.choices[0]).toHaveProperty("index", 0);
      expect(res.body.choices[0]).toHaveProperty("message");
      expect(res.body.choices[0].message).toHaveProperty("role", "assistant");
      expect(res.body.choices[0].message).toHaveProperty("content");
      expect(typeof res.body.choices[0].message.content).toBe("string");
      expect(res.body.choices[0]).toHaveProperty("finish_reason", "stop");
      expect(res.body).toHaveProperty("usage");
      expect(res.body.usage).toHaveProperty("prompt_tokens");
      expect(res.body.usage).toHaveProperty("completion_tokens");
      expect(res.body.usage).toHaveProperty("total_tokens");
    });

    it("does not include steering_metadata when no steering config provided", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send(validPayload())
        .expect(200);

      expect(res.body).not.toHaveProperty("steering_metadata");
    });

    it("accepts optional temperature and top_p", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send(validPayload({ temperature: 0.7, top_p: 0.9 }))
        .expect(200);

      expect(res.body).toHaveProperty("object", "chat.completion");
    });

    it("accepts optional max_tokens", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send(validPayload({ max_tokens: 256 }))
        .expect(200);

      expect(res.body).toHaveProperty("object", "chat.completion");
    });

    it("accepts multiple messages in conversation", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send(
          validPayload({
            messages: [
              { role: "system", content: "You are helpful." },
              { role: "user", content: "Hi" },
              { role: "assistant", content: "Hello!" },
              { role: "user", content: "How are you?" },
            ],
          }),
        )
        .expect(200);

      expect(res.body.choices[0].message.content).toContain("How are you?");
    });
  });

  describe("steering config with profile_id resolution", () => {
    it("resolves a valid profile_id and includes steering_metadata", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send(
          validPayload({
            steering: {
              profile_id: "steer-gemma3-default-v12",
            },
          }),
        )
        .expect(200);

      expect(res.body).toHaveProperty("steering_metadata");
      const meta = res.body.steering_metadata;
      expect(meta.profile_id).toBe("steer-gemma3-default-v12");
      expect(meta.base_model).toBe("gemma-3-27b-it");
      expect(meta.base_model_revision).toBe("2026-03-15");
      expect(meta.active_layers).toEqual([23, 29, 35, 41, 47]);
      expect(meta.vector_bundle_id).toBe("vec-bundle-2026-04-01-rc2");
      expect(meta.effective_multiplier).toBe(0.22); // default preset = medium
    });

    it("uses preset multiplier from profile preset_table", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send(
          validPayload({
            steering: {
              profile_id: "steer-gemma3-default-v12",
              preset: "strong",
            },
          }),
        )
        .expect(200);

      expect(res.body.steering_metadata.effective_multiplier).toBe(0.34);
      expect(res.body.steering_metadata.preset).toBe("strong");
    });

    it("uses explicit multiplier override", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send(
          validPayload({
            steering: {
              profile_id: "steer-gemma3-default-v12",
              multiplier: 0.5,
            },
          }),
        )
        .expect(200);

      expect(res.body.steering_metadata.effective_multiplier).toBe(0.5);
    });

    it("uses custom layers override", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send(
          validPayload({
            steering: {
              profile_id: "steer-gemma3-default-v12",
              layers: [35, 41],
            },
          }),
        )
        .expect(200);

      expect(res.body.steering_metadata.active_layers).toEqual([35, 41]);
    });

    it("includes concept in metadata when provided", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send(
          validPayload({
            steering: {
              profile_id: "steer-gemma3-default-v12",
              concept: "curiosity",
            },
          }),
        )
        .expect(200);

      expect(res.body.steering_metadata.concept).toBe("curiosity");
    });

    it("returns 422 for unknown profile_id", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send(
          validPayload({
            steering: {
              profile_id: "nonexistent-profile-v99",
            },
          }),
        )
        .expect(422);

      expect(res.body.error.code).toBe("profile_not_found");
      expect(res.body.error.param).toBe("steering.profile_id");
      expect(res.body.error.type).toBe("invalid_request_error");
    });
  });

  describe("invalid payload test matrix", () => {
    it("rejects request with missing model", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send({ messages: [{ role: "user", content: "Hi" }] })
        .expect(400);

      expect(res.body.error.type).toBe("invalid_request_error");
    });

    it("rejects request with missing messages", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send({ model: "gemma-3-27b-it" })
        .expect(400);

      expect(res.body.error.type).toBe("invalid_request_error");
    });

    it("rejects request with empty messages array", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send({ model: "gemma-3-27b-it", messages: [] })
        .expect(400);

      expect(res.body.error.type).toBe("invalid_request_error");
    });

    it("rejects request with empty model string", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send({ model: "", messages: [{ role: "user", content: "Hi" }] })
        .expect(400);

      expect(res.body.error.type).toBe("invalid_request_error");
    });

    it("rejects request with invalid message role", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send({
          model: "gemma-3-27b-it",
          messages: [{ role: "invalid_role", content: "Hi" }],
        })
        .expect(400);

      expect(res.body.error.type).toBe("invalid_request_error");
    });

    it("rejects steering with empty profile_id", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send(
          validPayload({
            steering: { profile_id: "" },
          }),
        )
        .expect(400);

      expect(res.body.error.type).toBe("invalid_request_error");
    });

    it("rejects steering with missing profile_id", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send(
          validPayload({
            steering: { concept: "curiosity" },
          }),
        )
        .expect(400);

      expect(res.body.error.type).toBe("invalid_request_error");
    });

    it("rejects steering with invalid preset value", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send(
          validPayload({
            steering: {
              profile_id: "steer-gemma3-default-v12",
              preset: "ultra",
            },
          }),
        )
        .expect(400);

      expect(res.body.error.type).toBe("invalid_request_error");
    });

    it("rejects steering with negative multiplier", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send(
          validPayload({
            steering: {
              profile_id: "steer-gemma3-default-v12",
              multiplier: -0.5,
            },
          }),
        )
        .expect(400);

      expect(res.body.error.type).toBe("invalid_request_error");
    });

    it("rejects steering with zero multiplier", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send(
          validPayload({
            steering: {
              profile_id: "steer-gemma3-default-v12",
              multiplier: 0,
            },
          }),
        )
        .expect(400);

      expect(res.body.error.type).toBe("invalid_request_error");
    });

    it("rejects steering with empty layers array", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send(
          validPayload({
            steering: {
              profile_id: "steer-gemma3-default-v12",
              layers: [],
            },
          }),
        )
        .expect(400);

      expect(res.body.error.type).toBe("invalid_request_error");
    });

    it("rejects steering with negative layer index", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send(
          validPayload({
            steering: {
              profile_id: "steer-gemma3-default-v12",
              layers: [-1, 23],
            },
          }),
        )
        .expect(400);

      expect(res.body.error.type).toBe("invalid_request_error");
    });

    it("rejects temperature out of range", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send(validPayload({ temperature: 3.0 }))
        .expect(400);

      expect(res.body.error.type).toBe("invalid_request_error");
    });

    it("rejects top_p out of range", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send(validPayload({ top_p: 1.5 }))
        .expect(400);

      expect(res.body.error.type).toBe("invalid_request_error");
    });

    it("rejects unknown top-level fields (strict mode)", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send(validPayload({ unknown_field: "should fail" }))
        .expect(400);

      expect(res.body.error.type).toBe("invalid_request_error");
    });

    it("rejects unknown steering fields (strict mode)", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send(
          validPayload({
            steering: {
              profile_id: "steer-gemma3-default-v12",
              unknown_steering_field: true,
            },
          }),
        )
        .expect(400);

      expect(res.body.error.type).toBe("invalid_request_error");
    });

    it("returns deterministic error shape for all 4xx responses", async () => {
      const app = makeApp();
      const res = await request(app)
        .post("/v1/chat/completions")
        .send({})
        .expect(400);

      expect(res.body).toHaveProperty("error");
      expect(res.body.error).toHaveProperty("message");
      expect(res.body.error).toHaveProperty("type");
      expect(res.body.error).toHaveProperty("code");
      expect(typeof res.body.error.message).toBe("string");
    });
  });

  describe("profile registry", () => {
    it("supports multiple registered profiles", async () => {
      const secondProfile: SteeringProfile = {
        ...TEST_PROFILE,
        profile_id: "steer-gemma3-aggressive-v1",
        preset_table: { low: 0.2, medium: 0.4, strong: 0.6 },
      };
      const app = makeApp([TEST_PROFILE, secondProfile]);

      const res = await request(app)
        .post("/v1/chat/completions")
        .send(
          validPayload({
            steering: {
              profile_id: "steer-gemma3-aggressive-v1",
              preset: "low",
            },
          }),
        )
        .expect(200);

      expect(res.body.steering_metadata.profile_id).toBe(
        "steer-gemma3-aggressive-v1",
      );
      expect(res.body.steering_metadata.effective_multiplier).toBe(0.2);
    });

    it("ProfileRegistry.register adds new profiles", () => {
      const registry = new ProfileRegistry([]);
      registry.register(TEST_PROFILE);
      expect(registry.resolve("steer-gemma3-default-v12")).toEqual(
        TEST_PROFILE,
      );
    });

    it("ProfileRegistry.register rejects duplicate profile_id", () => {
      const registry = new ProfileRegistry([TEST_PROFILE]);
      expect(() => registry.register(TEST_PROFILE)).toThrow("already exists");
    });

    it("ProfileRegistry.list returns all profiles", () => {
      const registry = new ProfileRegistry([TEST_PROFILE]);
      expect(registry.list()).toHaveLength(1);
      expect(registry.list()[0].profile_id).toBe("steer-gemma3-default-v12");
    });

    it("ProfileRegistry.resolve returns null for unknown id", () => {
      const registry = new ProfileRegistry([]);
      expect(registry.resolve("unknown")).toBeNull();
    });
  });

  describe("provider adapter integration", () => {
    it("calls the adapter and returns provider response", async () => {
      const adapter = makeMockAdapter();
      const app = makeAppWithAdapter(adapter);

      const res = await request(app)
        .post("/v1/chat/completions")
        .send(validPayload())
        .expect(200);

      expect(adapter.chatCompletion).toHaveBeenCalledOnce();
      expect(res.body.id).toBe("chatcmpl-provider-test-001");
      expect(res.body.object).toBe("chat.completion");
      expect(res.body.model).toBe("gemma-3-27b-it");
      expect(res.body.choices[0].message.content).toBe("Provider response content");
      expect(res.body.usage.prompt_tokens).toBe(50);
      expect(res.body.usage.completion_tokens).toBe(20);
      expect(res.body.usage.total_tokens).toBe(70);
    });

    it("forwards model and messages to adapter", async () => {
      const adapter = makeMockAdapter();
      const app = makeAppWithAdapter(adapter);

      await request(app)
        .post("/v1/chat/completions")
        .send(validPayload({ temperature: 0.5, max_tokens: 100 }))
        .expect(200);

      const call = (adapter.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0][0] as ProviderRequest;
      expect(call.model).toBe("gemma-3-27b-it");
      expect(call.messages).toEqual([{ role: "user", content: "Hello" }]);
      expect(call.temperature).toBe(0.5);
      expect(call.max_tokens).toBe(100);
    });

    it("forwards steering params to adapter when profile resolves", async () => {
      const adapter = makeMockAdapter();
      const app = makeAppWithAdapter(adapter);

      await request(app)
        .post("/v1/chat/completions")
        .send(
          validPayload({
            steering: {
              profile_id: "steer-gemma3-default-v12",
              concept: "expense-management",
              preset: "strong",
              layers: [35, 41],
              multiplier: 0.3,
            },
          }),
        )
        .expect(200);

      const call = (adapter.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0][0] as ProviderRequest;
      expect(call.steering).toBeDefined();
      expect(call.steering!.concept).toBe("expense-management");
      expect(call.steering!.layers).toEqual([35, 41]);
      expect(call.steering!.multiplier).toBe(0.3);
      expect(call.steering!.profile_id).toBe("steer-gemma3-default-v12");
    });

    it("attaches steering_metadata to successful provider responses", async () => {
      const adapter = makeMockAdapter();
      const app = makeAppWithAdapter(adapter);

      const res = await request(app)
        .post("/v1/chat/completions")
        .send(
          validPayload({
            steering: {
              profile_id: "steer-gemma3-default-v12",
              concept: "curiosity",
              preset: "medium",
            },
          }),
        )
        .expect(200);

      expect(res.body).toHaveProperty("steering_metadata");
      const meta = res.body.steering_metadata;
      expect(meta.profile_id).toBe("steer-gemma3-default-v12");
      expect(meta.active_layers).toEqual([23, 29, 35, 41, 47]);
      expect(meta.effective_multiplier).toBe(0.22);
      expect(meta.concept).toBe("curiosity");
      expect(meta.preset).toBe("medium");
    });

    it("does not include steering_metadata when no steering config with adapter", async () => {
      const adapter = makeMockAdapter();
      const app = makeAppWithAdapter(adapter);

      const res = await request(app)
        .post("/v1/chat/completions")
        .send(validPayload())
        .expect(200);

      expect(res.body).not.toHaveProperty("steering_metadata");
    });
  });

  describe("provider error handling", () => {
    it("maps ProviderError to structured 5xx response with provider_error type", async () => {
      const adapter = makeMockAdapter(async () => {
        throw new ProviderError("Model service unavailable", 502, true, "provider_internal_error");
      });
      const app = makeAppWithAdapter(adapter);

      const res = await request(app)
        .post("/v1/chat/completions")
        .send(validPayload())
        .expect(502);

      expect(res.body.error).toBeDefined();
      expect(res.body.error.message).toBe("Model service unavailable");
      expect(res.body.error.type).toBe("provider_error");
      expect(res.body.error.code).toBe("provider_internal_error");
      expect(res.body.error.retryable).toBe(true);
    });

    it("maps rate limit errors with retryable flag", async () => {
      const adapter = makeMockAdapter(async () => {
        throw new ProviderError("Too many requests", 529, true, "provider_rate_limited");
      });
      const app = makeAppWithAdapter(adapter);

      const res = await request(app)
        .post("/v1/chat/completions")
        .send(validPayload())
        .expect(529);

      expect(res.body.error.code).toBe("provider_rate_limited");
      expect(res.body.error.retryable).toBe(true);
    });

    it("maps connection errors to 502", async () => {
      const adapter = makeMockAdapter(async () => {
        throw new ProviderError("Upstream provider unreachable: fetch failed", 502, true, "provider_connection_error");
      });
      const app = makeAppWithAdapter(adapter);

      const res = await request(app)
        .post("/v1/chat/completions")
        .send(validPayload())
        .expect(502);

      expect(res.body.error.code).toBe("provider_connection_error");
      expect(res.body.error.retryable).toBe(true);
    });

    it("attaches steering_metadata to error responses when profile resolved", async () => {
      const adapter = makeMockAdapter(async () => {
        throw new ProviderError("Provider down", 502, true, "provider_internal_error");
      });
      const app = makeAppWithAdapter(adapter);

      const res = await request(app)
        .post("/v1/chat/completions")
        .send(
          validPayload({
            steering: {
              profile_id: "steer-gemma3-default-v12",
              concept: "expense-management",
              preset: "strong",
            },
          }),
        )
        .expect(502);

      expect(res.body.error).toBeDefined();
      expect(res.body.steering_metadata).toBeDefined();
      expect(res.body.steering_metadata.profile_id).toBe("steer-gemma3-default-v12");
      expect(res.body.steering_metadata.concept).toBe("expense-management");
      expect(res.body.steering_metadata.preset).toBe("strong");
      expect(res.body.steering_metadata.effective_multiplier).toBe(0.34);
    });

    it("does not attach steering_metadata to error responses without steering config", async () => {
      const adapter = makeMockAdapter(async () => {
        throw new ProviderError("Provider down", 502, true, "provider_internal_error");
      });
      const app = makeAppWithAdapter(adapter);

      const res = await request(app)
        .post("/v1/chat/completions")
        .send(validPayload())
        .expect(502);

      expect(res.body.error).toBeDefined();
      expect(res.body).not.toHaveProperty("steering_metadata");
    });

    it("maps unknown errors to 500 with internal_error code", async () => {
      const adapter = makeMockAdapter(async () => {
        throw new Error("Unexpected crash");
      });
      const app = makeAppWithAdapter(adapter);

      const res = await request(app)
        .post("/v1/chat/completions")
        .send(validPayload())
        .expect(500);

      expect(res.body.error.type).toBe("server_error");
      expect(res.body.error.code).toBe("internal_error");
      expect(res.body.error.retryable).toBe(true);
    });

    it("unknown errors with steering still attach metadata", async () => {
      const adapter = makeMockAdapter(async () => {
        throw new Error("Runtime panic");
      });
      const app = makeAppWithAdapter(adapter);

      const res = await request(app)
        .post("/v1/chat/completions")
        .send(
          validPayload({
            steering: {
              profile_id: "steer-gemma3-default-v12",
              concept: "curiosity",
            },
          }),
        )
        .expect(500);

      expect(res.body.error.code).toBe("internal_error");
      expect(res.body.steering_metadata).toBeDefined();
      expect(res.body.steering_metadata.profile_id).toBe("steer-gemma3-default-v12");
      expect(res.body.steering_metadata.concept).toBe("curiosity");
    });

    it("validation errors still return 4xx before reaching provider", async () => {
      const adapter = makeMockAdapter();
      const app = makeAppWithAdapter(adapter);

      const res = await request(app)
        .post("/v1/chat/completions")
        .send({ messages: [{ role: "user", content: "Hi" }] })
        .expect(400);

      expect(adapter.chatCompletion).not.toHaveBeenCalled();
      expect(res.body.error.type).toBe("invalid_request_error");
    });

    it("profile_not_found still returns 422 before reaching provider", async () => {
      const adapter = makeMockAdapter();
      const app = makeAppWithAdapter(adapter);

      const res = await request(app)
        .post("/v1/chat/completions")
        .send(
          validPayload({
            steering: { profile_id: "nonexistent-v99" },
          }),
        )
        .expect(422);

      expect(adapter.chatCompletion).not.toHaveBeenCalled();
      expect(res.body.error.code).toBe("profile_not_found");
    });
  });
});
