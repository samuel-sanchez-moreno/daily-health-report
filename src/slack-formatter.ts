import { AggregatedReport, ServiceSeverity, E2eStageSeverity } from "./aggregator.js";
import { Severity } from "./health-check.js";
import { SERVICES, ENVIRONMENTS } from "./config.js";

type SlackBlock = Record<string, unknown>;

const SEVERITY_EMOJI: Record<Severity, string> = {
  green: "🟢",
  yellow: "🟡",
  red: "🔴",
};

function headerBlock(text: string): SlackBlock {
  return { type: "header", text: { type: "plain_text", text, emoji: true } };
}

function markdownBlock(text: string): SlackBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function divider(): SlackBlock {
  return { type: "divider" };
}

function contextBlock(text: string): SlackBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

function formatDate(): string {
  return new Date().toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function buildPrioritySection(report: AggregatedReport): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  if (report.urgentItems.length > 0) {
    const items = report.urgentItems.map((i) => `  • ${i}`).join("\n");
    blocks.push(markdownBlock(`*🔴 URGENT (${report.urgentItems.length})*\n${items}`));
  }

  if (report.attentionItems.length > 0) {
    const items = report.attentionItems.map((i) => `  • ${i}`).join("\n");
    blocks.push(markdownBlock(`*🟡 ATTENTION (${report.attentionItems.length})*\n${items}`));
  }

  if (report.skippedContexts.length > 0) {
    const items = report.skippedContexts.map((c) => `  • ⚠️ ${c}`).join("\n");
    blocks.push(markdownBlock(`*⚠️ Skipped*\n${items}`));
  }

  if (blocks.length === 0) {
    blocks.push(markdownBlock("✅ *All services healthy* — no urgent items"));
  }

  return blocks;
}

function buildEnvironmentMatrix(report: AggregatedReport): SlackBlock {
  // Build severity lookup: env/service -> severity
  const lookup = new Map<string, Severity>();
  for (const s of report.serviceResults) {
    const key = `${s.result.environment.context}/${s.result.service.name}`;
    lookup.set(key, s.severity);
  }

  // Short names for services
  const shortNames: Record<string, string> = {
    BAS: "bas",
    "lima-bas-adapter": "lba",
    "lima-tenant-config": "ltc",
    "entitlement-service": "ent",
  };

  // Build e2e severity lookup
  const e2eLookup = new Map<string, Severity>();
  for (const e of report.e2eResults) {
    e2eLookup.set(e.result.stage, e.severity);
  }

  // Env contexts (excluding e2e-test-tenant for the matrix — it's shown in e2e section)
  const envContexts = ENVIRONMENTS.filter((e) => !e.hasE2eTests).map((e) => e.context);

  let table = "```\n";
  const header = "           | " + envContexts.map((e) => e.padEnd(7)).join("| ") + "|";
  table += header + "\n";
  table += "-".repeat(header.length) + "\n";

  for (const svc of SERVICES) {
    const short = (shortNames[svc.name] || svc.name).padEnd(10);
    const cells = envContexts.map((env) => {
      const sev = lookup.get(`${env}/${svc.name}`);
      return (sev ? SEVERITY_EMOJI[sev] : "⚪").padEnd(7);
    });
    table += `${short} | ${cells.join("| ")}|\n`;
  }

  table += "```";
  return markdownBlock(table);
}

function buildE2eSection(report: AggregatedReport): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  const hasFailures = report.e2eResults.some((e) => e.result.failures.length > 0);
  const hasErrors = report.e2eResults.some((e) => e.result.errors.length > 0);

  if (!hasFailures && !hasErrors) {
    blocks.push(markdownBlock("*🧪 E2E Tests* — ✅ All passing"));
    return blocks;
  }

  blocks.push(markdownBlock("*🧪 E2E Test Failures (last 24h)*"));

  for (const e of report.e2eResults) {
    if (e.result.failures.length === 0 && e.result.errors.length === 0) continue;

    let text = `*e2e-${e.result.stage}:*\n`;

    for (const f of e.result.failures) {
      const emoji = f.status === "Failed" ? "❌" : "⚠️";
      const flakyNote = f.status === "Flaky" ? " _(Flaky — passed after reruns)_" : "";
      text += `${emoji} \`${f.testName}\`${flakyNote}\n`;
      if (f.stackTrace) {
        text += `     → \`${f.stackTrace}\`\n`;
      }
      if (f.sourceUrl) {
        text += `     📄 <${f.sourceUrl}|source>\n`;
      }
    }

    for (const err of e.result.errors) {
      text += `⚠️ Query error: ${err}\n`;
    }

    blocks.push(markdownBlock(text.trim()));
  }

  return blocks;
}

export function formatSlackMessage(report: AggregatedReport, durationMs: number): Record<string, unknown> {
  const blocks: SlackBlock[] = [];

  // Header
  blocks.push(headerBlock(`🏥 Team Licoco Daily Health Report — ${formatDate()}`));
  blocks.push(divider());

  // Priority section
  blocks.push(...buildPrioritySection(report));
  blocks.push(divider());

  // Environment matrix
  blocks.push(markdownBlock("*📊 Environment Matrix*"));
  blocks.push(buildEnvironmentMatrix(report));
  blocks.push(divider());

  // E2E test failures section
  blocks.push(...buildE2eSection(report));
  blocks.push(divider());

  // Per-issue details (for red/yellow services)
  const issueServices = report.serviceResults.filter((s) => s.severity !== "green");
  if (issueServices.length > 0) {
    blocks.push(markdownBlock("*📋 Issue Details*"));
    for (const s of issueServices) {
      const label = `${s.result.environment.context}/${s.result.service.name}`;
      const emoji = SEVERITY_EMOJI[s.severity];
      let detail = `${emoji} *${label}*\n`;
      for (const reason of s.reasons) {
        detail += `  • ${reason}\n`;
      }
      // Add top HTTP endpoints with issues
      const badEndpoints = s.result.httpEndpoints.filter((e) => e.errors5xx > 0 || e.p95Ms > 5000);
      if (badEndpoints.length > 0) {
        detail += "  _Endpoints:_\n";
        for (const ep of badEndpoints.slice(0, 5)) {
          detail += `    \`${ep.spanName}\` — P95: ${ep.p95Ms}ms, 5xx: ${ep.errors5xx}, reqs: ${ep.count.toLocaleString()}\n`;
        }
      }
      blocks.push(markdownBlock(detail.trim()));
    }
    blocks.push(divider());
  }

  // Footer
  const totalQueries = report.serviceResults.length * 6 + report.e2eResults.length;
  const queryErrors = report.serviceResults.reduce((sum, s) => sum + s.result.errors.length, 0)
    + report.e2eResults.reduce((sum, e) => sum + e.result.errors.length, 0);
  const durationSec = (durationMs / 1000).toFixed(0);

  blocks.push(
    contextBlock(
      `⏱️ Generated in ${durationSec}s | Queries: ~${totalQueries} | Errors: ${queryErrors}`,
    ),
  );

  return { blocks };
}
