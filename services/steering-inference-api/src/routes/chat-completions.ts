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
import {
  type ModelAdapter,
  type ProviderResponse,
  ProviderError,
} from "../providers/model-adapter.js";

export interface ChatCompletionsRouterOptions {
  registry: ProfileRegistry;
  adapter: ModelAdapter;
}

export function createChatCompletionsRouter(
  registryOrOpts: ProfileRegistry | ChatCompletionsRouterOptions,
): Router {
  const router = Router();

  const opts: ChatCompletionsRouterOptions =
    registryOrOpts instanceof ProfileRegistry
      ? { registry: registryOrOpts, adapter: undefined as unknown as ModelAdapter }
      : registryOrOpts;

  const registry = opts.registry;
  const adapter: ModelAdapter | undefined =
    registryOrOpts instanceof ProfileRegistry ? undefined : opts.adapter;

  router.post("/v1/chat/completions", async (req: Request, res: Response) => {
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

    let providerResponse: ProviderResponse | undefined;

    if (adapter) {
      try {
        providerResponse = await adapter.chatCompletion({
          model: body.model,
          messages: body.messages,
          temperature: body.temperature,
          max_tokens: body.max_tokens,
          steering: resolvedProfile && activeLayers && effectiveMultiplier !== undefined
            ? {
                concept: body.steering?.concept,
                preset: body.steering?.preset,
                layers: activeLayers,
                multiplier: effectiveMultiplier,
                profile_id: resolvedProfile.profile_id,
              }
            : undefined,
        });
      } catch (err: unknown) {
        if (err instanceof ProviderError) {
          const errorResponse: Record<string, unknown> = {
            error: {
              message: err.message,
              type: "provider_error",
              param: null,
              code: err.providerCode,
              retryable: err.retryable,
            },
          };

          if (resolvedProfile) {
            errorResponse.steering_metadata = buildSteeringMetadata(
              resolvedProfile,
              body,
              activeLayers,
              effectiveMultiplier,
            );
          }

          res.status(err.statusCode).json(errorResponse);
          return;
        }

        const errorResponse: Record<string, unknown> = {
          error: {
            message: "Internal server error",
            type: "server_error",
            param: null,
            code: "internal_error",
            retryable: true,
          },
        };

        if (resolvedProfile) {
          errorResponse.steering_metadata = buildSteeringMetadata(
            resolvedProfile,
            body,
            activeLayers,
            effectiveMultiplier,
          );
        }

        res.status(500).json(errorResponse);
        return;
      }
    }

    const response: Record<string, unknown> = providerResponse
      ? {
          id: providerResponse.id,
          object: providerResponse.object,
          created: providerResponse.created,
          model: providerResponse.model,
          choices: providerResponse.choices,
          usage: providerResponse.usage,
        }
      : buildStubResponse(body);

    if (resolvedProfile) {
      response.steering_metadata = buildSteeringMetadata(
        resolvedProfile,
        body,
        activeLayers,
        effectiveMultiplier,
      );
    }

    res.status(200).json(response);
  });

  return router;
}

function buildSteeringMetadata(
  profile: SteeringProfile,
  body: ChatCompletionRequest,
  activeLayers: number[] | undefined,
  effectiveMultiplier: number | undefined,
): Record<string, unknown> {
  return {
    profile_id: profile.profile_id,
    base_model: profile.base_model,
    base_model_revision: profile.base_model_revision,
    active_layers: activeLayers,
    effective_multiplier: effectiveMultiplier,
    vector_bundle_id: profile.vector_bundle_id,
    concept: body.steering?.concept ?? null,
    preset: body.steering?.preset ?? null,
  };
}

function buildStubResponse(body: ChatCompletionRequest): Record<string, unknown> {
  const completionId = `chatcmpl-${uuidv4().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  const lastUserMessage = [...body.messages]
    .reverse()
    .find((m) => m.role === "user");

  const assistantContent = lastUserMessage
    ? `This is a stub response to: "${lastUserMessage.content}"`
    : "This is a stub response.";

  return {
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
}
