# Daily Health Report — Team Licoco

Automated daily health report for team-licoco services across Dynatrace environments, posted to Slack.

## What it reports

| # | Metric | Environments |
|---|--------|-------------|
| 1 | Pod status (down/ReplicaSet drift) | dev, sprint, prod |
| 2 | Pod restarts (K8S events) | dev, sprint, prod |
| 3 | Error/warning log counts | dev, sprint, prod |
| 4 | Active DAVIS problems | dev, sprint, prod |
| 5 | HTTP 5xx errors | dev, sprint, prod |
| 6 | Response time P95 | dev, sprint, prod |
| 7 | Kafka consumer lag | dev, sprint, prod |
| 8 | E2E test failures + stack traces | e2e-test-tenant (dev, sprint stages) |

**Services**: BAS, lima-bas-adapter, lima-tenant-config, entitlement-service

**Timeframe**: Last 24 hours

## Prerequisites

- **Node.js** >= 18
- **dtctl** CLI installed and authenticated for all contexts (`dev`, `sprint`, `prod`, `e2e-test-tenant`)

```bash
# Verify dtctl is installed
which dtctl

# Authenticate each context (opens browser)
dtctl auth login --context dev --environment https://gmg80500.dev.apps.dynatracelabs.com
dtctl auth login --context sprint --environment https://eva38390.sprint.apps.dynatracelabs.com
dtctl auth login --context prod --environment https://dre63214.apps.dynatrace.com
dtctl auth login --context e2e-test-tenant --environment https://drs84959.sprint.apps.dynatracelabs.com
```

## Setup

```bash
cd team-licoco/daily-health-report
npm install
```

## Run manually

```bash
# Without Slack (prints to stdout)
npm run report

# With Slack
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL npm run report
```

## Schedule (macOS launchd)

1. Edit the plist to set your Slack webhook URL:
   ```bash
   vim com.team-licoco.daily-health-report.plist
   ```
   Uncomment the `SLACK_WEBHOOK_URL` key and set your webhook URL.

2. Install the launch agent:
   ```bash
   cp com.team-licoco.daily-health-report.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.team-licoco.daily-health-report.plist
   ```

3. Verify it's loaded:
   ```bash
   launchctl list | grep daily-health
   ```

4. Test manually:
   ```bash
   launchctl start com.team-licoco.daily-health-report
   ```

5. Check logs:
   ```bash
   tail -f /tmp/daily-health-report.stdout.log
   tail -f /tmp/daily-health-report.stderr.log
   ```

### Uninstall
```bash
launchctl unload ~/Library/LaunchAgents/com.team-licoco.daily-health-report.plist
rm ~/Library/LaunchAgents/com.team-licoco.daily-health-report.plist
```

## Configuration

Edit `src/config.ts` to adjust:

- **Services**: Add/remove services from `SERVICES` array
- **Environments**: Add/remove dtctl contexts from `ENVIRONMENTS` array
- **Thresholds**: Tune severity thresholds in `THRESHOLDS`
- **E2E team owner**: Change `E2E_TEAM_OWNER` if team name differs

## Thresholds

| Metric | 🟡 Warning | 🔴 Critical |
|--------|-----------|------------|
| Pod restarts | ≥ 2 / 24h | ≥ 5 / 24h |
| Error logs | ≥ 100 / 24h | ≥ 500 / 24h |
| DAVIS problems | — | Any active |
| HTTP 5xx | ≥ 1 | ≥ 1% rate |
| Response P95 | ≥ 5,000ms | ≥ 15,000ms |
| Consumer lag | ≥ 1,000 | ≥ 10,000 |
| E2E test failures | ≥ 1 | ≥ 3 |

## Troubleshooting

### Token expired
If a context's token expires, the report skips that environment and flags it:
```
⚠️ Skipped: sprint (token expired)
```
Re-authenticate: `dtctl auth login --context sprint --environment <url>`

### dtctl not found
Ensure dtctl is in your PATH. The launchd plist includes `/usr/local/bin` and `/opt/homebrew/bin`.

### Report not posting to Slack
- Check that `SLACK_WEBHOOK_URL` is set correctly
- Test the webhook: `curl -X POST -H 'Content-Type: application/json' -d '{"text":"test"}' $SLACK_WEBHOOK_URL`

## Future: Migration to Dynatrace Workflow

The DQL queries in `src/queries/` are designed to be directly reusable in a Dynatrace AutomationEngine Workflow. When the report format stabilizes, migrate to Approach B for always-on reliability without local machine dependency.
