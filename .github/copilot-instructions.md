# Copilot Instructions — daily-health-report

## Build & Run

```bash
npm run build          # tsc → dist/
npm run dev            # tsx src/index.ts (no build step)
npm run report         # alias for dev
```

No tests or linter configured.

## Prerequisites

- **Node.js** ≥ 18
- **dtctl** CLI authenticated for contexts: `dev`, `sprint`, `prod`, `e2e-test-tenant`

## Architecture

Pipeline that collects health metrics from Dynatrace via `dtctl` CLI and posts a summary to Slack:

```
config.ts          — services, environments, thresholds (all tuning lives here)
    ↓
index.ts           — orchestrator: iterates envs × services sequentially
    ↓
dtctl.ts           — shell wrapper around `dtctl` CLI (context switching, DQL queries)
    ↓
health-check.ts    — runs 6 DQL queries per service/env, returns ServiceHealthResult
e2e-test-check.ts  — runs e2e failure query per stage, returns E2eTestResult
    ↓
aggregator.ts      — applies threshold rules, classifies into green/yellow/red severity
    ↓
slack-formatter.ts — builds Slack Block Kit payload (environment matrix, priority items)
slack-poster.ts    — POSTs to Slack webhook with retry + exponential backoff
```

### DQL Query Templates

`src/queries/*.dql` files are DQL (Dynatrace Query Language) templates with `{{variable}}` placeholders. They are loaded at runtime via `readFileSync` and interpolated with `interpolateQuery()` from `dtctl.ts`. When adding a new query, create a `.dql` file in `src/queries/` and use the same `{{placeholder}}` pattern.

### Sequential Execution

Health checks run **sequentially** (not parallel) to prevent dtctl token race conditions. The `switchContext()` call changes the active dtctl context globally, so concurrent queries would conflict.

## Key Conventions

- **TypeScript ESM**: All imports use `.js` extensions (`import { foo } from "./bar.js"`), required by `NodeNext` module resolution
- **Config-driven**: Services, environments, and thresholds are arrays/objects in `config.ts` — add new services or environments there, not in health-check logic
- **Severity model**: Three levels — `green`, `yellow` (warning), `red` (critical) — assessed per service/env pair in `aggregator.ts`
- **dtctl output parsing**: `tryParseJson()` handles both raw arrays and `{ records: [...] }` response shapes from dtctl
- **Graceful degradation**: Expired tokens skip the environment with a warning rather than failing the entire report
- **Scheduling**: macOS launchd plist runs weekdays at 09:00; set `SLACK_WEBHOOK_URL` env var to enable Slack posting (otherwise prints to stdout)
