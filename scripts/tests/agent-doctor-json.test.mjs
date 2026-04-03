import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const doctorScript = path.join(repoRoot, "scripts/agent-doctor.mjs");
const schemaPath = path.join(repoRoot, "schemas/doctor-report.schema.json");

function runDoctor(extraArgs = [], env = {}) {
  const result = execFileSync("node", [doctorScript, ...extraArgs], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      EXECUTOR_BOT_TOKEN: "",
      LANGSMITH_API_KEY: "",
      LANGCHAIN_API_KEY: "",
    },
    timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result;
}

function runDoctorRaw(extraArgs = [], env = {}) {
  try {
    const stdout = execFileSync("node", [doctorScript, ...extraArgs], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ...env,
        EXECUTOR_BOT_TOKEN: "",
        LANGSMITH_API_KEY: "",
        LANGCHAIN_API_KEY: "",
      },
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, exitCode: 0 };
  } catch (error) {
    return { stdout: error.stdout || "", exitCode: error.status };
  }
}

describe("doctor --format json", () => {
  it("outputs valid JSON matching the doctor-report schema", () => {
    const { stdout, exitCode } = runDoctorRaw(["--format", "json"]);
    const report = JSON.parse(stdout);

    // Validate schema_version
    assert.equal(report.schema_version, 1);

    // Validate timestamp is ISO 8601
    assert.ok(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(report.timestamp),
      `timestamp should be ISO 8601: ${report.timestamp}`,
    );

    // Validate summary shape
    assert.ok(typeof report.summary === "object", "summary must be an object");
    assert.ok(typeof report.summary.ok === "number", "summary.ok must be a number");
    assert.ok(typeof report.summary.warn === "number", "summary.warn must be a number");
    assert.ok(typeof report.summary.fail === "number", "summary.fail must be a number");
    assert.ok(typeof report.summary.total === "number", "summary.total must be a number");
    assert.equal(
      report.summary.ok + report.summary.warn + report.summary.fail,
      report.summary.total,
      "summary counts must add up to total",
    );

    // Validate checks array
    assert.ok(Array.isArray(report.checks), "checks must be an array");
    assert.ok(report.checks.length > 0, "checks must not be empty");
    for (const check of report.checks) {
      assert.ok(["ok", "warn", "fail"].includes(check.level), `invalid level: ${check.level}`);
      assert.ok(typeof check.title === "string" && check.title.length > 0, "title must be non-empty string");
      assert.ok(typeof check.message === "string", "message must be a string");
      if (check.remediation !== undefined) {
        assert.ok(typeof check.remediation === "string", "remediation must be a string when present");
      }
      // No extra keys
      const allowed = new Set(["level", "title", "message", "remediation"]);
      for (const key of Object.keys(check)) {
        assert.ok(allowed.has(key), `unexpected key in check: ${key}`);
      }
    }
  });

  it("includes remediation on failing checks", () => {
    const { stdout } = runDoctorRaw(["--format", "json"]);
    const report = JSON.parse(stdout);
    const failingChecks = report.checks.filter((c) => c.level === "fail" || c.level === "warn");
    const withRemediation = failingChecks.filter((c) => c.remediation);
    assert.ok(
      withRemediation.length > 0,
      "at least one failing/warning check should include a remediation action",
    );
  });

  it("schema file exists and is valid JSON Schema", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    assert.equal(schema.type, "object");
    assert.ok(schema.required.includes("schema_version"));
    assert.ok(schema.required.includes("timestamp"));
    assert.ok(schema.required.includes("summary"));
    assert.ok(schema.required.includes("checks"));
    assert.ok(schema.properties.checks.items.properties.remediation, "schema must define remediation field");
  });
});

describe("secret redaction", () => {
  it("never prints raw secret values in JSON mode", () => {
    const fakeToken = "ghp_SuperSecretFakeTokenValue1234567890abc";
    const fakeApiKey = "lsv2_pt_FakeLangSmithKeyValue9876543210xyz";
    const { stdout } = runDoctorRaw(["--format", "json"], {
      EXECUTOR_BOT_TOKEN: fakeToken,
      LANGSMITH_API_KEY: fakeApiKey,
      LANGCHAIN_API_KEY: fakeApiKey,
    });

    assert.ok(!stdout.includes(fakeToken), "JSON output must not contain raw EXECUTOR_BOT_TOKEN");
    assert.ok(!stdout.includes(fakeApiKey), "JSON output must not contain raw LANGSMITH_API_KEY");

    const report = JSON.parse(stdout);
    for (const check of report.checks) {
      assert.ok(
        !check.message.includes(fakeToken) && !check.message.includes(fakeApiKey),
        `check "${check.title}" leaks a secret in message`,
      );
      if (check.remediation) {
        assert.ok(
          !check.remediation.includes(fakeToken) && !check.remediation.includes(fakeApiKey),
          `check "${check.title}" leaks a secret in remediation`,
        );
      }
    }
  });

  it("never prints raw secret values in text mode", () => {
    const fakeToken = "ghp_TextModeSecretToken1234567890abcdefgh";
    const fakeApiKey = "lsv2_pt_TextModeLangSmithKey9876543210xyz";
    const { stdout } = runDoctorRaw(["--format", "text"], {
      EXECUTOR_BOT_TOKEN: fakeToken,
      LANGSMITH_API_KEY: fakeApiKey,
      LANGCHAIN_API_KEY: fakeApiKey,
    });

    assert.ok(!stdout.includes(fakeToken), "text output must not contain raw EXECUTOR_BOT_TOKEN");
    assert.ok(!stdout.includes(fakeApiKey), "text output must not contain raw LANGSMITH_API_KEY");
  });
});

describe("--strict thresholds", () => {
  it("exits non-zero in strict mode when failures meet default threshold", () => {
    // Without EXECUTOR_BOT_TOKEN, there will be a fail result
    const { exitCode } = runDoctorRaw(["--strict"]);
    assert.notEqual(exitCode, 0, "strict mode should exit non-zero when fail checks exist");
  });

  it("exits non-zero in strict mode when warnings meet --warn-threshold", () => {
    const { exitCode } = runDoctorRaw(["--strict", "--warn-threshold", "1"]);
    assert.notEqual(exitCode, 0, "strict mode with --warn-threshold 1 should exit non-zero when warnings exist");
  });

  it("exits zero when thresholds are not breached", () => {
    // Set fail threshold very high so failures don't trigger exit
    const { exitCode } = runDoctorRaw(["--strict", "--fail-threshold", "999"]);
    assert.equal(exitCode, 0, "strict mode should exit 0 when thresholds are not breached");
  });
});
