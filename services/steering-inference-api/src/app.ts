import express from "express";
import { createChatCompletionsRouter } from "./routes/chat-completions.js";
import { ProfileRegistry } from "./profiles/registry.js";

export function createApp(registry?: ProfileRegistry): express.Express {
  const app = express();
  const profileRegistry = registry ?? new ProfileRegistry();

  app.use(express.json());
  app.use(createChatCompletionsRouter(profileRegistry));

  return app;
}
