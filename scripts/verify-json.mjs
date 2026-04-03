import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();

const JSON_DIRS = ["tasks", "tasks/schema"];

async function main() {
  const errors = [];
  let fileCount = 0;

  for (const dir of JSON_DIRS) {
    const fullDir = path.join(ROOT, dir);
    let entries;
    try {
      entries = await readdir(fullDir, { withFileTypes: true });
    } catch {
      continue;
    }

    const jsonFiles = entries.filter(
      (e) => e.isFile() && e.name.endsWith(".json")
    );

    for (const entry of jsonFiles) {
      const filePath = path.join(fullDir, entry.name);
      const relPath = path.relative(ROOT, filePath);
      const raw = await readFile(filePath, "utf8");

      try {
        JSON.parse(raw);
        fileCount++;
      } catch (error) {
        errors.push(`${relPath}: invalid JSON — ${error.message}`);
      }
    }
  }

  if (errors.length > 0) {
    console.error("JSON validation failed:\n");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`Validated ${fileCount} JSON files successfully.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
