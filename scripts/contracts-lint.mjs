#!/usr/bin/env node

/**
 * Validates JSON schemas are well-formed against the JSON Schema 2020-12 meta-schema.
 * OpenAPI linting is handled separately by @redocly/cli in the contracts:lint script.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const ROOT = process.cwd();
const SCHEMA_DIR = path.join(ROOT, "contracts", "schema");

const SCHEMA_FILES = [
  "profile.json",
  "run-metadata.json",
  "experiment-decision.json",
];

let exitCode = 0;

console.log("=== JSON Schema meta-validation ===");
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
try { ajv.addKeyword("examples"); } catch (_) {}

for (const file of SCHEMA_FILES) {
  const filePath = path.join(SCHEMA_DIR, file);
  try {
    const raw = await readFile(filePath, "utf8");
    const schema = JSON.parse(raw);
    ajv.compile(schema);
    console.log(`  ✓ ${file}`);
  } catch (err) {
    console.error(`  ✗ ${file}: ${err.message}`);
    exitCode = 1;
  }
}

process.exit(exitCode);
