import { readFileSync } from "node:fs";
import { join } from "node:path";
import { switchContext, checkAuth, runQuery, interpolateQuery } from "./dtctl.js";
import { EnvironmentConfig, E2E_TEAM_OWNER } from "./config.js";

export interface E2eTestFailure {
  timestamp: string;
  testName: string;
  status: "Failed" | "Flaky";
  rawStatus: string;
  stackTrace: string;
  sourceUrl: string;
}

export interface E2eTestResult {
  environment: EnvironmentConfig;
  stage: string;
  authOk: boolean;
  failures: E2eTestFailure[];
  errors: string[];
}

function loadQuery(name: string): string {
  const queryDir = join(import.meta.dirname, "queries");
  return readFileSync(join(queryDir, `${name}.dql`), "utf-8").trim();
}

function tryParseJson(data: string): unknown[] {
  try {
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.records)) return parsed.records;
    return [parsed];
  } catch {
    return [];
  }
}

function truncateStackTrace(trace: string, maxLen: number = 200): string {
  if (!trace) return "";
  const firstLine = trace.split("\n")[0] || "";
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, maxLen) + "...";
}

export async function runE2eTestCheck(env: EnvironmentConfig): Promise<E2eTestResult[]> {
  const results: E2eTestResult[] = [];

  if (!env.hasE2eTests || !env.e2eStages?.length) return results;

  // Switch context
  const ctxResult = await switchContext(env.context);
  if (!ctxResult.success) {
    for (const stage of env.e2eStages) {
      results.push({
        environment: env,
        stage,
        authOk: false,
        failures: [],
        errors: [`Failed to switch to context ${env.context}: ${ctxResult.error}`],
      });
    }
    return results;
  }

  const authOk = await checkAuth(env.context);
  if (!authOk) {
    for (const stage of env.e2eStages) {
      results.push({
        environment: env,
        stage,
        authOk: false,
        failures: [],
        errors: [`TOKEN_EXPIRED for context ${env.context}`],
      });
    }
    return results;
  }

  for (const stage of env.e2eStages) {
    console.log(`  [${env.context}/${stage}] Querying e2e test failures...`);
    const result: E2eTestResult = {
      environment: env,
      stage,
      authOk: true,
      failures: [],
      errors: [],
    };

    const query = interpolateQuery(loadQuery("e2e-test-failures"), {
      team_owner: E2E_TEAM_OWNER,
      stage,
    });

    const queryResult = await runQuery(query);
    if (queryResult.success) {
      const records = tryParseJson(queryResult.data) as Record<string, unknown>[];
      result.failures = records.map((r) => ({
        timestamp: String(r.timestamp || ""),
        testName: String(r["test.name"] || ""),
        status: String(r.status || "").includes("Flaky") ? "Flaky" as const : "Failed" as const,
        rawStatus: String(r["test_result.statusmessage"] || ""),
        stackTrace: truncateStackTrace(String(r["test_execution.stacktrace"] || "")),
        sourceUrl: String(r["test.origin_url"] || ""),
      }));
    } else {
      result.errors.push(`E2E test query failed: ${queryResult.error}`);
    }

    results.push(result);
  }

  return results;
}
