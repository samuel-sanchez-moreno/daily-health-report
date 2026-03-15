import { SERVICES, ENVIRONMENTS } from "./config.js";
import { runServiceHealthCheck, ServiceHealthResult } from "./health-check.js";
import { runE2eTestCheck, E2eTestResult } from "./e2e-test-check.js";
import { aggregateResults } from "./aggregator.js";
import { formatSlackMessage } from "./slack-formatter.js";
import { postToSlack } from "./slack-poster.js";

async function main() {
  const startTime = Date.now();

  console.log("🏥 Team Licoco Daily Health Report");
  console.log(`📅 ${new Date().toISOString()}`);
  console.log(`📊 Checking ${SERVICES.length} services × ${ENVIRONMENTS.length} environments\n`);

  // Run health checks sequentially (dtctl token race condition prevention)
  const serviceResults: ServiceHealthResult[] = [];

  for (const env of ENVIRONMENTS) {
    // Skip e2e-test-tenant for standard service health checks
    if (env.hasE2eTests) continue;

    for (const service of SERVICES) {
      console.log(`\n🔍 ${env.context}/${service.name}`);
      const result = await runServiceHealthCheck(service, env);
      serviceResults.push(result);

      if (!result.authOk) {
        console.log(`  ⚠️  Skipped — token expired`);
      } else if (result.errors.length > 0) {
        console.log(`  ⚠️  Completed with ${result.errors.length} error(s)`);
      } else {
        console.log(`  ✅ Done`);
      }
    }
  }

  // Run e2e test checks
  const e2eResults: E2eTestResult[] = [];
  for (const env of ENVIRONMENTS) {
    if (!env.hasE2eTests) continue;

    console.log(`\n🧪 E2E tests (${env.context})`);
    const results = await runE2eTestCheck(env);
    e2eResults.push(...results);

    for (const r of results) {
      if (!r.authOk) {
        console.log(`  ⚠️  ${r.stage}: Skipped — token expired`);
      } else if (r.failures.length > 0) {
        console.log(`  ❌ ${r.stage}: ${r.failures.length} failure(s)`);
      } else {
        console.log(`  ✅ ${r.stage}: All passing`);
      }
    }
  }

  // Aggregate
  console.log("\n📊 Aggregating results...");
  const report = aggregateResults(serviceResults, e2eResults);

  const durationMs = Date.now() - startTime;

  // Format and post
  const slackPayload = formatSlackMessage(report, durationMs);
  console.log("\n📤 Posting to Slack...");
  const postResult = await postToSlack(slackPayload);

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log(`🏁 Report complete in ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`   🔴 Urgent: ${report.urgentItems.length}`);
  console.log(`   🟡 Attention: ${report.attentionItems.length}`);
  console.log(`   ⚠️  Skipped: ${report.skippedContexts.length}`);
  console.log(`   📤 Slack: ${postResult.success ? "✅ Posted" : `❌ Failed (${postResult.error})`}`);

  // Exit with non-zero if there were critical issues posting
  if (!postResult.success && postResult.error !== undefined) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("💥 Fatal error:", err);
  process.exit(2);
});
