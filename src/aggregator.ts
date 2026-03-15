import { THRESHOLDS } from "./config.js";
import { ServiceHealthResult, Severity } from "./health-check.js";
import { E2eTestResult } from "./e2e-test-check.js";

export interface ServiceSeverity {
  result: ServiceHealthResult;
  severity: Severity;
  reasons: string[];
}

export interface E2eStageSeverity {
  result: E2eTestResult;
  severity: Severity;
  reasons: string[];
}

export interface AggregatedReport {
  timestamp: string;
  serviceResults: ServiceSeverity[];
  e2eResults: E2eStageSeverity[];
  urgentItems: string[];
  attentionItems: string[];
  skippedContexts: string[];
}

function assessServiceSeverity(r: ServiceHealthResult): ServiceSeverity {
  const reasons: string[] = [];
  let severity: Severity = "green";

  const escalate = (level: Severity, reason: string) => {
    reasons.push(reason);
    if (level === "red") severity = "red";
    else if (level === "yellow" && severity !== "red") severity = "yellow";
  };

  if (!r.authOk) {
    return { result: r, severity: "yellow", reasons: [`Token expired for ${r.environment.context}`] };
  }

  // Pod status
  const downPods = r.pods.filter((p) => p.status === "down").length;
  if (downPods >= THRESHOLDS.pods.downCritical) {
    escalate("red", `${downPods} pod(s) down`);
  }
  if (r.multipleReplicaSets) {
    escalate("yellow", "Multiple ReplicaSets active (deployment in progress or stuck)");
  }

  // Pod restarts
  if (r.podRestartCount >= THRESHOLDS.pods.restartCritical) {
    escalate("red", `${r.podRestartCount} pod restarts in 24h`);
  } else if (r.podRestartCount >= THRESHOLDS.pods.restartWarn) {
    escalate("yellow", `${r.podRestartCount} pod restarts in 24h`);
  }

  // Error logs
  const errorCount = r.logCounts
    .filter((l) => l.loglevel === "ERROR" || l.loglevel === "SEVERE")
    .reduce((sum, l) => sum + l.cnt, 0);
  if (errorCount >= THRESHOLDS.errors.criticalCount) {
    escalate("red", `${errorCount.toLocaleString()} errors in 24h`);
  } else if (errorCount >= THRESHOLDS.errors.warnCount) {
    escalate("yellow", `${errorCount.toLocaleString()} errors in 24h`);
  }

  // DAVIS problems
  if (r.davisProblems.length > 0 && THRESHOLDS.davis.anyCritical) {
    escalate("red", `${r.davisProblems.length} active DAVIS problem(s): ${r.davisProblems[0].eventName}`);
  }

  // HTTP 5xx
  const total5xx = r.httpEndpoints.reduce((sum, e) => sum + e.errors5xx, 0);
  const totalReqs = r.httpEndpoints.reduce((sum, e) => sum + e.count, 0);
  const pct5xx = totalReqs > 0 ? (total5xx / totalReqs) * 100 : 0;
  if (pct5xx >= THRESHOLDS.http.error5xxCritPct) {
    escalate("red", `${total5xx} 5xx errors (${pct5xx.toFixed(1)}% error rate)`);
  } else if (total5xx >= THRESHOLDS.http.error5xxWarn) {
    escalate("yellow", `${total5xx} 5xx errors`);
  }

  // HTTP P95
  const maxP95 = Math.max(0, ...r.httpEndpoints.map((e) => e.p95Ms));
  if (maxP95 >= THRESHOLDS.http.p95CritMs) {
    escalate("red", `P95 response time ${maxP95.toLocaleString()}ms`);
  } else if (maxP95 >= THRESHOLDS.http.p95WarnMs) {
    escalate("yellow", `P95 response time ${maxP95.toLocaleString()}ms`);
  }

  // Consumer lag
  const maxLag = Math.max(0, ...r.consumerLag.map((l) => l.maxLag));
  if (maxLag >= THRESHOLDS.consumerLag.criticalLag) {
    const topTopic = r.consumerLag.reduce((a, b) => (a.maxLag > b.maxLag ? a : b), r.consumerLag[0]);
    escalate("red", `Consumer lag ${maxLag.toLocaleString()} (topic: ${topTopic?.topic || "?"})`);
  } else if (maxLag >= THRESHOLDS.consumerLag.warnLag) {
    escalate("yellow", `Consumer lag ${maxLag.toLocaleString()}`);
  }

  // Query errors
  if (r.errors.length > 0) {
    escalate("yellow", `${r.errors.length} query error(s)`);
  }

  return { result: r, severity, reasons };
}

function assessE2eSeverity(r: E2eTestResult): E2eStageSeverity {
  const reasons: string[] = [];
  let severity: Severity = "green";

  if (!r.authOk) {
    return { result: r, severity: "yellow", reasons: [`Token expired for ${r.environment.context}`] };
  }

  const failedCount = r.failures.filter((f) => f.status === "Failed").length;
  const flakyCount = r.failures.filter((f) => f.status === "Flaky").length;

  if (failedCount >= THRESHOLDS.e2eTests.failedCritical) {
    severity = "red";
    reasons.push(`${failedCount} failed e2e tests`);
  } else if (failedCount >= THRESHOLDS.e2eTests.failedWarn) {
    severity = "yellow";
    reasons.push(`${failedCount} failed e2e test(s)`);
  }

  if (flakyCount > 0) {
    if (severity === "green") severity = "yellow";
    reasons.push(`${flakyCount} flaky test(s)`);
  }

  if (r.errors.length > 0) {
    if (severity === "green") severity = "yellow";
    reasons.push(`${r.errors.length} query error(s)`);
  }

  return { result: r, severity, reasons };
}

export function aggregateResults(
  serviceResults: ServiceHealthResult[],
  e2eResults: E2eTestResult[],
): AggregatedReport {
  const assessed = serviceResults.map(assessServiceSeverity);
  const e2eAssessed = e2eResults.map(assessE2eSeverity);

  const urgentItems: string[] = [];
  const attentionItems: string[] = [];
  const skippedContexts: string[] = [];

  for (const s of assessed) {
    const label = `${s.result.environment.context}/${s.result.service.name}`;
    if (!s.result.authOk) {
      skippedContexts.push(`${s.result.environment.context} (token expired)`);
      continue;
    }
    if (s.severity === "red") {
      urgentItems.push(`${label} — ${s.reasons.join(", ")}`);
    } else if (s.severity === "yellow") {
      attentionItems.push(`${label} — ${s.reasons.join(", ")}`);
    }
  }

  for (const e of e2eAssessed) {
    const label = `e2e-${e.result.stage}`;
    if (!e.result.authOk) {
      skippedContexts.push(`${e.result.environment.context}/${e.result.stage} (token expired)`);
      continue;
    }
    if (e.severity === "red") {
      urgentItems.push(`${label} — ${e.reasons.join(", ")}`);
    } else if (e.severity === "yellow") {
      attentionItems.push(`${label} — ${e.reasons.join(", ")}`);
    }
  }

  // Deduplicate skipped contexts
  const uniqueSkipped = [...new Set(skippedContexts)];

  return {
    timestamp: new Date().toISOString(),
    serviceResults: assessed,
    e2eResults: e2eAssessed,
    urgentItems,
    attentionItems,
    skippedContexts: uniqueSkipped,
  };
}
