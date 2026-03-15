import { readFileSync } from "node:fs";
import { join } from "node:path";
import { switchContext, checkAuth, runQuery, interpolateQuery } from "./dtctl.js";
import { ServiceConfig, EnvironmentConfig, TIMEFRAME } from "./config.js";

export type Severity = "green" | "yellow" | "red";

export interface PodInfo {
  name: string;
  status: "running" | "down";
  replicaSetHash: string;
  startTime: string;
}

export interface LogSeverityCount {
  loglevel: string;
  cnt: number;
}

export interface DavisProblem {
  timestamp: string;
  eventName: string;
  eventType: string;
  entityName: string;
}

export interface HttpEndpoint {
  spanName: string;
  medianMs: number;
  p95Ms: number;
  count: number;
  errors5xx: number;
}

export interface ConsumerLagEntry {
  consumerGroup: string;
  topic: string;
  maxLag: number;
}

export interface ServiceHealthResult {
  service: ServiceConfig;
  environment: EnvironmentConfig;
  timestamp: string;
  authOk: boolean;
  pods: PodInfo[];
  podRestartCount: number;
  multipleReplicaSets: boolean;
  logCounts: LogSeverityCount[];
  davisProblems: DavisProblem[];
  httpEndpoints: HttpEndpoint[];
  consumerLag: ConsumerLagEntry[];
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

function extractReplicaSetHash(podName: string): string {
  const parts = podName.split("-");
  return parts.length >= 3 ? parts[parts.length - 2] : "unknown";
}

export async function runServiceHealthCheck(
  service: ServiceConfig,
  env: EnvironmentConfig,
): Promise<ServiceHealthResult> {
  const result: ServiceHealthResult = {
    service,
    environment: env,
    timestamp: new Date().toISOString(),
    authOk: false,
    pods: [],
    podRestartCount: 0,
    multipleReplicaSets: false,
    logCounts: [],
    davisProblems: [],
    httpEndpoints: [],
    consumerLag: [],
    errors: [],
  };

  // Switch context and check auth
  const ctxResult = await switchContext(env.context);
  if (!ctxResult.success) {
    result.errors.push(`Failed to switch to context ${env.context}: ${ctxResult.error}`);
    return result;
  }

  const authOk = await checkAuth(env.context);
  if (!authOk) {
    result.errors.push(`TOKEN_EXPIRED for context ${env.context}`);
    return result;
  }
  result.authOk = true;

  const vars = {
    deployment_name: service.deploymentName,
    service_name: service.name,
    cluster_name: env.kafkaClusterName,
    kafka_namespace: env.kafkaNamespace,
    consumer_group: service.consumerGroupPattern,
  };

  // Q1 — Pods (run sequentially to avoid token race conditions)
  console.log(`  [${env.context}/${service.name}] Querying pods...`);
  const podsQuery = interpolateQuery(loadQuery("pods"), vars);
  const podsResult = await runQuery(podsQuery);
  if (podsResult.success) {
    const records = tryParseJson(podsResult.data);
    const replicaSets = new Set<string>();
    for (const r of records as Record<string, unknown>[]) {
      const name = String(r["entity.name"] || r["name"] || "");
      const lifetime = r["lifetime"] as Record<string, string> | undefined;
      const hash = extractReplicaSetHash(name);
      replicaSets.add(hash);
      result.pods.push({
        name,
        status: lifetime?.end ? "down" : "running",
        replicaSetHash: hash,
        startTime: lifetime?.start || "",
      });
    }
    result.multipleReplicaSets = replicaSets.size > 1;
  } else {
    result.errors.push(`Pods query failed: ${podsResult.error}`);
  }

  // Q2 — Pod restarts
  console.log(`  [${env.context}/${service.name}] Querying pod restarts...`);
  const restartsQuery = interpolateQuery(loadQuery("pod-restarts"), vars);
  const restartsResult = await runQuery(restartsQuery);
  if (restartsResult.success) {
    const records = tryParseJson(restartsResult.data);
    result.podRestartCount = records.length;
  } else {
    result.errors.push(`Pod restarts query failed: ${restartsResult.error}`);
  }

  // Q3 — Error logs
  console.log(`  [${env.context}/${service.name}] Querying error logs...`);
  const logsQuery = interpolateQuery(loadQuery("error-logs"), vars);
  const logsResult = await runQuery(logsQuery);
  if (logsResult.success) {
    const records = tryParseJson(logsResult.data) as Record<string, unknown>[];
    result.logCounts = records.map((r) => ({
      loglevel: String(r.loglevel || ""),
      cnt: Number(r.cnt || 0),
    }));
  } else {
    result.errors.push(`Error logs query failed: ${logsResult.error}`);
  }

  // Q4 — DAVIS problems
  console.log(`  [${env.context}/${service.name}] Querying DAVIS problems...`);
  const davisQuery = interpolateQuery(loadQuery("davis-problems"), vars);
  const davisResult = await runQuery(davisQuery);
  if (davisResult.success) {
    const records = tryParseJson(davisResult.data) as Record<string, unknown>[];
    result.davisProblems = records.map((r) => ({
      timestamp: String(r.timestamp || ""),
      eventName: String(r["event.name"] || ""),
      eventType: String(r["event.type"] || ""),
      entityName: String(r.entity_name || ""),
    }));
  } else {
    result.errors.push(`DAVIS problems query failed: ${davisResult.error}`);
  }

  // Q5 — HTTP endpoints
  console.log(`  [${env.context}/${service.name}] Querying HTTP endpoints...`);
  const httpQuery = interpolateQuery(loadQuery("http-endpoints"), vars);
  const httpResult = await runQuery(httpQuery);
  if (httpResult.success) {
    const records = tryParseJson(httpResult.data) as Record<string, unknown>[];
    result.httpEndpoints = records.map((r) => ({
      spanName: String(r["span.name"] || ""),
      medianMs: Math.round(Number(r.median_ms || 0)),
      p95Ms: Math.round(Number(r.p95_ms || 0)),
      count: Number(r.cnt || 0),
      errors5xx: Number(r.errors_5xx || 0),
    }));
  } else {
    result.errors.push(`HTTP endpoints query failed: ${httpResult.error}`);
  }

  // Q6 — Consumer lag (skip if service doesn't use Kafka or env has no cluster)
  if (service.hasKafka && env.kafkaClusterName) {
    console.log(`  [${env.context}/${service.name}] Querying consumer lag...`);
    const lagQuery = interpolateQuery(loadQuery("consumer-lag"), vars);
    const lagResult = await runQuery(lagQuery);
    if (lagResult.success) {
      const records = tryParseJson(lagResult.data) as Record<string, unknown>[];
      result.consumerLag = records.map((r) => ({
        consumerGroup: String(r.consumergroup || ""),
        topic: String(r.topic || ""),
        maxLag: Number(r.maxLag || 0),
      }));
    } else {
      result.errors.push(`Consumer lag query failed: ${lagResult.error}`);
    }
  }

  return result;
}
