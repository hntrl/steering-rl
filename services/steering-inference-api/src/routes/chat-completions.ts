import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import {
  validateRequest,
  type ChatCompletionRequest,
} from "../validation/steering-request.js";
import {
  ProfileRegistry,
  type SteeringProfile,
} from "../profiles/registry.js";

export function createChatCompletionsRouter(registry: ProfileRegistry): Router {
  const router = Router();

  router.post("/v1/chat/completions", (req: Request, res: Response) => {
    const validation = validateRequest(req.body);

    if (!validation.success) {
      res.status(validation.error.status).json(validation.error);
      return;
    }

    const body = validation.data;

    let resolvedProfile: SteeringProfile | null = null;
    let effectiveMultiplier: number | undefined;
    let activeLayers: number[] | undefined;

    if (body.steering) {
      resolvedProfile = registry.resolve(body.steering.profile_id);

      if (!resolvedProfile) {
        res.status(422).json({
          error: {
            message: `Steering profile '${body.steering.profile_id}' not found`,
            type: "invalid_request_error",
            param: "steering.profile_id",
            code: "profile_not_found",
          },
        });
        return;
      }

      activeLayers = body.steering.layers ?? resolvedProfile.layers;

      if (body.steering.multiplier !== undefined) {
        effectiveMultiplier = body.steering.multiplier;
      } else if (body.steering.preset !== undefined) {
        effectiveMultiplier = resolvedProfile.preset_table[body.steering.preset];
      } else {
        effectiveMultiplier = resolvedProfile.preset_table["medium"];
      }
    }

    const completionId = `chatcmpl-${uuidv4().replace(/-/g, "").slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);

    const lastUserMessage = [...body.messages]
      .reverse()
      .find((m) => m.role === "user");

    const assistantContent = lastUserMessage
      ? `This is a stub response to: "${lastUserMessage.content}"`
      : "This is a stub response.";

    const response: Record<string, unknown> = {
      id: completionId,
      object: "chat.completion",
      created,
      model: body.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: assistantContent,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };

    if (resolvedProfile) {
      response.steering_metadata = {
        profile_id: resolvedProfile.profile_id,
        base_model: resolvedProfile.base_model,
        base_model_revision: resolvedProfile.base_model_revision,
        active_layers: activeLayers,
        effective_multiplier: effectiveMultiplier,
        vector_bundle_id: resolvedProfile.vector_bundle_id,
        concept: body.steering?.concept ?? null,
        preset: body.steering?.preset ?? null,
      };
    }

    res.status(200).json(response);
  });

  return router;
}
