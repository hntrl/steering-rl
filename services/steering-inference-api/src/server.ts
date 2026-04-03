import { createApp } from "./app.js";

const PORT = parseInt(process.env.PORT ?? "3004", 10);

const app = createApp();

app.listen(PORT, () => {
  console.log(`steering-inference-api listening on port ${PORT}`);
});
