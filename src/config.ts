export interface ServiceConfig {
  name: string;
  deploymentName: string;
  consumerGroupPattern: string;
  /** Some services (like BAS) may not use Kafka — skip consumer lag if false */
  hasKafka: boolean;
}

export interface EnvironmentConfig {
  context: string;
  kafkaClusterName: string;
  kafkaNamespace: string;
  /** Whether to run e2e test failure queries in this env */
  hasE2eTests: boolean;
  /** For e2e-test-tenant: which stages to query (dev, sprint) */
  e2eStages?: string[];
}

export interface Thresholds {
  pods: { restartWarn: number; restartCritical: number; downCritical: number };
  errors: { warnCount: number; criticalCount: number };
  http: { p95WarnMs: number; p95CritMs: number; error5xxWarn: number; error5xxCritPct: number };
  consumerLag: { warnLag: number; criticalLag: number };
  davis: { anyCritical: boolean };
  e2eTests: { failedWarn: number; failedCritical: number };
}

export const SERVICES: ServiceConfig[] = [
  {
    name: "BAS",
    deploymentName: "bas",
    consumerGroupPattern: "bas",
    hasKafka: false, // BAS is an older Java service, confirm if it uses Kafka
  },
  {
    name: "lima-bas-adapter",
    deploymentName: "lima-bas-adapter",
    consumerGroupPattern: "lima-bas-adapter",
    hasKafka: true,
  },
  {
    name: "lima-tenant-config",
    deploymentName: "lima-tenant-config",
    consumerGroupPattern: "lima-tenant-config",
    hasKafka: true,
  },
  {
    name: "entitlement-service",
    deploymentName: "lima-entitlement",
    consumerGroupPattern: "lima-entitlement",
    hasKafka: true,
  },
];

export const ENVIRONMENTS: EnvironmentConfig[] = [
  {
    context: "dev",
    kafkaClusterName: "dtp-dev-csc-central-services",
    kafkaNamespace: "kafka-worker",
    hasE2eTests: false,
  },
  {
    context: "sprint",
    kafkaClusterName: "dtp-sprint-csc-central-services",
    kafkaNamespace: "kafka-worker",
    hasE2eTests: false,
  },
  {
    context: "prod",
    kafkaClusterName: "dtp-prod-csc-central-services",
    kafkaNamespace: "kafka-worker",
    hasE2eTests: false,
  },
  {
    context: "e2e-test-tenant",
    kafkaClusterName: "", // e2e tenant may not have Kafka metrics
    kafkaNamespace: "",
    hasE2eTests: true,
    e2eStages: ["dev", "sprint"],
  },
];

export const THRESHOLDS: Thresholds = {
  pods: { restartWarn: 2, restartCritical: 5, downCritical: 1 },
  errors: { warnCount: 100, criticalCount: 500 },
  http: { p95WarnMs: 5000, p95CritMs: 15000, error5xxWarn: 1, error5xxCritPct: 1 },
  consumerLag: { warnLag: 1000, criticalLag: 10000 },
  davis: { anyCritical: true },
  e2eTests: { failedWarn: 1, failedCritical: 3 },
};

export const TIMEFRAME = "24h";

export const E2E_TEAM_OWNER = "team-licoco";

export const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
