import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import { seedProfile, clearProfiles } from "../src/store.js";
import type { SteeringProfile, StructuredError, ReleaseManifest } from "../src/types.js";

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

describe("profile-registry", () => {
  const app = buildApp();

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    clearProfiles();
  });

  describe("GET /profiles/:profile_id", () => {
    it("returns exact profile payload for known profile_id", async () => {
      seedProfile(TEST_PROFILE);

      const response = await app.inject({
        method: "GET",
        url: `/profiles/${TEST_PROFILE.profile_id}`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual(TEST_PROFILE);
    });

    it("includes model revision, layers, presets, and vector bundle id", async () => {
      seedProfile(TEST_PROFILE);

      const response = await app.inject({
        method: "GET",
        url: `/profiles/${TEST_PROFILE.profile_id}`,
      });

      const body = response.json();
      expect(body.base_model_revision).toBe("2026-03-15");
      expect(body.layers).toEqual([23, 29, 35, 41, 47]);
      expect(body.preset_table).toEqual({
        low: 0.12,
        medium: 0.22,
        strong: 0.34,
      });
      expect(body.vector_bundle_id).toBe("vec-bundle-2026-04-01-rc2");
    });

    it("returns 404 with structured error for unknown profile_id", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/profiles/nonexistent-profile",
      });

      expect(response.statusCode).toBe(404);
      const body: StructuredError = response.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe("PROFILE_NOT_FOUND");
      expect(body.error.message).toBe("Profile 'nonexistent-profile' not found");
      expect(body.error.status).toBe(404);
    });

    it("returns content-type application/json", async () => {
      seedProfile(TEST_PROFILE);

      const response = await app.inject({
        method: "GET",
        url: `/profiles/${TEST_PROFILE.profile_id}`,
      });

      expect(response.headers["content-type"]).toMatch(/application\/json/);
    });
  });

  describe("GET /profiles/:profile_id/manifest", () => {
    it("returns immutable release metadata", async () => {
      seedProfile(TEST_PROFILE);

      const response = await app.inject({
        method: "GET",
        url: `/profiles/${TEST_PROFILE.profile_id}/manifest`,
      });

      expect(response.statusCode).toBe(200);
      const body: ReleaseManifest = response.json();
      expect(body.profile_id).toBe(TEST_PROFILE.profile_id);
      expect(body.base_model).toBe(TEST_PROFILE.base_model);
      expect(body.base_model_revision).toBe(TEST_PROFILE.base_model_revision);
      expect(body.layers).toEqual(TEST_PROFILE.layers);
      expect(body.vector_bundle_id).toBe(TEST_PROFILE.vector_bundle_id);
      expect(body.preset_table).toEqual(TEST_PROFILE.preset_table);
      expect(body.created_at).toBe(TEST_PROFILE.created_at);
      expect(body.immutable).toBe(true);
    });

    it("does not include fallback_layer or judge_bundle in manifest", async () => {
      seedProfile(TEST_PROFILE);

      const response = await app.inject({
        method: "GET",
        url: `/profiles/${TEST_PROFILE.profile_id}/manifest`,
      });

      const body = response.json();
      expect(body).not.toHaveProperty("fallback_layer");
      expect(body).not.toHaveProperty("judge_bundle");
    });

    it("returns 404 with structured error for unknown profile_id", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/profiles/nonexistent-profile/manifest",
      });

      expect(response.statusCode).toBe(404);
      const body: StructuredError = response.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe("PROFILE_NOT_FOUND");
      expect(body.error.message).toBe("Profile 'nonexistent-profile' not found");
      expect(body.error.status).toBe(404);
    });
  });

  describe("immutability", () => {
    it("prevents overwriting an existing profile", async () => {
      seedProfile(TEST_PROFILE);
      expect(() => seedProfile(TEST_PROFILE)).toThrowError(
        /already exists and is immutable/
      );
    });

    it("stores profiles as frozen objects", async () => {
      seedProfile(TEST_PROFILE);

      const response = await app.inject({
        method: "GET",
        url: `/profiles/${TEST_PROFILE.profile_id}`,
      });

      const body = response.json();
      expect(Object.keys(body)).toContain("profile_id");
      expect(body.profile_id).toBe(TEST_PROFILE.profile_id);
    });
  });
});
