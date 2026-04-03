import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import express from "express";
import { createApp } from "../src/app.js";
import { ProfileRegistry, type SteeringProfile } from "../src/profiles/registry.js";

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
});
