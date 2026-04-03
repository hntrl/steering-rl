import Fastify from "fastify";
import { registerGetProfile } from "./routes/get-profile.js";
import { registerGetManifest } from "./routes/get-manifest.js";

export function buildApp() {
  const app = Fastify({ logger: false });

  registerGetProfile(app);
  registerGetManifest(app);

  return app;
}
