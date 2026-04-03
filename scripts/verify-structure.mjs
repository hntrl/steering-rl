import { access, readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();

const REQUIRED_FILES = [
  "package.json",
  "AGENTS.md",
  "tasks/schema/task-contract.schema.json",
];

const REQUIRED_DIRS = ["tasks", "scripts"];

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const errors = [];

  for (const file of REQUIRED_FILES) {
    const fullPath = path.join(ROOT, file);
    if (!(await exists(fullPath))) {
      errors.push(`missing required file: ${file}`);
    }
  }

  for (const dir of REQUIRED_DIRS) {
    const fullPath = path.join(ROOT, dir);
    if (!(await exists(fullPath))) {
      errors.push(`missing required directory: ${dir}`);
    }
  }

  const pkgPath = path.join(ROOT, "package.json");
  if (await exists(pkgPath)) {
    const raw = await readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw);
    if (!pkg.scripts?.verify) {
      errors.push("package.json must define a 'verify' script");
    }
  }

  if (errors.length > 0) {
    console.error("Structure verification failed:\n");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log("Project structure verified successfully.");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
