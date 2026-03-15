import { SLACK_WEBHOOK_URL } from "./config.js";

export interface SlackPostResult {
  success: boolean;
  statusCode?: number;
  error?: string;
}

export async function postToSlack(payload: Record<string, unknown>): Promise<SlackPostResult> {
  if (!SLACK_WEBHOOK_URL) {
    console.log("⚠️  SLACK_WEBHOOK_URL not set — printing report to stdout instead");
    console.log(JSON.stringify(payload, null, 2));
    return { success: true, statusCode: 200 };
  }

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        console.log(`✅ Slack message posted successfully (status: ${response.status})`);
        return { success: true, statusCode: response.status };
      }

      const body = await response.text();
      console.error(`❌ Slack POST failed (status: ${response.status}, attempt ${attempt}/${maxRetries}): ${body}`);

      // Don't retry on 4xx (client errors) — only on 5xx (server errors)
      if (response.status < 500) {
        return { success: false, statusCode: response.status, error: body };
      }

      // Wait before retry (exponential backoff)
      if (attempt < maxRetries) {
        const waitMs = 1000 * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`❌ Slack POST error (attempt ${attempt}/${maxRetries}): ${message}`);

      if (attempt < maxRetries) {
        const waitMs = 1000 * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      } else {
        return { success: false, error: message };
      }
    }
  }

  return { success: false, error: "Max retries exceeded" };
}
