import type { FastifyInstance } from "fastify";
import { getProfile } from "../store.js";
import type { ReleaseManifest, StructuredError } from "../types.js";

export async function registerGetManifest(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { profile_id: string } }>(
    "/profiles/:profile_id/manifest",
    async (request, reply) => {
      const { profile_id } = request.params;
      const profile = getProfile(profile_id);

      if (!profile) {
        const error: StructuredError = {
          error: {
            code: "PROFILE_NOT_FOUND",
            message: `Profile '${profile_id}' not found`,
            status: 404,
          },
        };
        return reply.status(404).send(error);
      }

      const manifest: ReleaseManifest = {
        profile_id: profile.profile_id,
        base_model: profile.base_model,
        base_model_revision: profile.base_model_revision,
        layers: profile.layers,
        vector_bundle_id: profile.vector_bundle_id,
        preset_table: profile.preset_table,
        created_at: profile.created_at,
        immutable: true,
      };

      return reply.status(200).send(manifest);
    }
  );
}
