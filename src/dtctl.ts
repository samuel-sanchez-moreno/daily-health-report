import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DtctlResult {
  success: boolean;
  data: string;
  error?: string;
}

async function runDtctl(args: string[]): Promise<DtctlResult> {
  try {
    const { stdout, stderr } = await execFileAsync("dtctl", args, {
      timeout: 120_000, // 2 min per query
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    return { success: true, data: stdout.trim() };
  } catch (err: unknown) {
    const error = err as Error & { stderr?: string; stdout?: string };
    const message = error.stderr || error.message || "Unknown error";

    if (message.includes("invalid_grant") || message.includes("UNSUCCESSFUL_OAUTH_REFRESH_TOKEN_VALIDATION")) {
      return { success: false, data: "", error: `TOKEN_EXPIRED: ${message.slice(0, 200)}` };
    }
    return { success: false, data: "", error: message.slice(0, 500) };
  }
}

export async function switchContext(context: string): Promise<DtctlResult> {
  return runDtctl(["config", "use-context", context]);
}

export async function checkAuth(context: string): Promise<boolean> {
  const result = await runDtctl(["auth", "whoami", "--context", context]);
  return result.success;
}

export async function runQuery(dql: string, outputFormat: string = "json"): Promise<DtctlResult> {
  return runDtctl(["query", dql, "-o", outputFormat]);
}

export function interpolateQuery(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}
