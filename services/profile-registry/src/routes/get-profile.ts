import type { FastifyInstance } from "fastify";
import { getProfile } from "../store.js";
import type { StructuredError } from "../types.js";

export async function registerGetProfile(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { profile_id: string } }>(
    "/profiles/:profile_id",
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

      return reply.status(200).send(profile);
    }
  );
}
