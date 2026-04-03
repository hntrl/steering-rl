import express from "express";
import { createChatCompletionsRouter } from "./routes/chat-completions.js";
import { ProfileRegistry } from "./profiles/registry.js";
import { type ModelAdapter } from "./providers/model-adapter.js";

export interface AppOptions {
  registry?: ProfileRegistry;
  adapter?: ModelAdapter;
}

export function createApp(registryOrOpts?: ProfileRegistry | AppOptions): express.Express {
  const app = express();

  let registry: ProfileRegistry;
  let adapter: ModelAdapter | undefined;

  if (registryOrOpts instanceof ProfileRegistry) {
    registry = registryOrOpts;
  } else if (registryOrOpts) {
    registry = registryOrOpts.registry ?? new ProfileRegistry();
    adapter = registryOrOpts.adapter;
  } else {
    registry = new ProfileRegistry();
  }

  app.use(express.json());

  if (adapter) {
    app.use(createChatCompletionsRouter({ registry, adapter }));
  } else {
    app.use(createChatCompletionsRouter(registry));
  }

  return app;
}
