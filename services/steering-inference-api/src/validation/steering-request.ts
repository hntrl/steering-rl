import { z } from "zod";

const MessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

const SteeringConfigSchema = z
  .object({
    profile_id: z.string().min(1, "profile_id must be non-empty"),
    concept: z.string().min(1).optional(),
    preset: z.enum(["low", "medium", "strong"]).optional(),
    layers: z.array(z.number().int().min(0)).min(1).optional(),
    multiplier: z.number().positive().optional(),
  })
  .strict();

export const ChatCompletionRequestSchema = z
  .object({
    model: z.string().min(1, "model is required"),
    messages: z.array(MessageSchema).min(1, "messages must not be empty"),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_tokens: z.number().int().positive().optional(),
    stream: z.literal(false).or(z.literal(true)).optional(),
    steering: SteeringConfigSchema.optional(),
  })
  .strict();

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
export type SteeringConfig = z.infer<typeof SteeringConfigSchema>;

export interface ValidationError {
  status: number;
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string;
  };
}

export function validateRequest(
  body: unknown,
): { success: true; data: ChatCompletionRequest } | { success: false; error: ValidationError } {
  const result = ChatCompletionRequestSchema.safeParse(body);

  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const param = firstIssue.path.length > 0 ? firstIssue.path.join(".") : null;

    return {
      success: false,
      error: {
        status: 400,
        error: {
          message: firstIssue.message,
          type: "invalid_request_error",
          param,
          code: "invalid_value",
        },
      },
    };
  }

  return { success: true, data: result.data };
}
