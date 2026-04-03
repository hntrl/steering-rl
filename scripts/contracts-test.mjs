#!/usr/bin/env node

/**
 * Validates fixture files against their corresponding JSON schemas.
 * - *.valid.json fixtures must validate successfully.
 * - *.invalid.json fixtures must fail validation.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const ROOT = process.cwd();
const SCHEMA_DIR = path.join(ROOT, "contracts", "schema");
const FIXTURE_DIR = path.join(ROOT, "contracts", "fixtures");

const SCHEMAS = [
  { name: "profile", file: "profile.json" },
  { name: "run-metadata", file: "run-metadata.json" },
  { name: "experiment-decision", file: "experiment-decision.json" },
];

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
try { ajv.addKeyword("examples"); } catch (_) {}

let passed = 0;
let failed = 0;

async function loadJSON(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

for (const { name, file } of SCHEMAS) {
  const schemaPath = path.join(SCHEMA_DIR, file);
  const schema = await loadJSON(schemaPath);
  const validate = ajv.compile(schema);

  console.log(`\n=== Schema: ${name} ===`);

  // Test valid fixture
  const validPath = path.join(FIXTURE_DIR, `${name}.valid.json`);
  try {
    const validData = await loadJSON(validPath);
    const isValid = validate(validData);
    if (isValid) {
      console.log(`  ✓ ${name}.valid.json passes validation`);
      passed++;
    } else {
      console.error(`  ✗ ${name}.valid.json should pass but got errors:`);
      for (const err of validate.errors) {
        console.error(`    - ${err.instancePath || "/"}: ${err.message}`);
      }
      failed++;
    }
  } catch (err) {
    console.error(`  ✗ ${name}.valid.json: ${err.message}`);
    failed++;
  }

  // Test invalid fixture
  const invalidPath = path.join(FIXTURE_DIR, `${name}.invalid.json`);
  try {
    const invalidData = await loadJSON(invalidPath);
    const isValid = validate(invalidData);
    if (!isValid) {
      console.log(`  ✓ ${name}.invalid.json correctly fails validation`);
      passed++;
    } else {
      console.error(`  ✗ ${name}.invalid.json should fail but passed validation`);
      failed++;
    }
  } catch (err) {
    console.error(`  ✗ ${name}.invalid.json: ${err.message}`);
    failed++;
  }
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
