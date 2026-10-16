import type { Tool } from "@modelcontextprotocol/sdk/types.js";
export type Status = "pass" | "warn" | "fail" | "skipped";
export interface Finding {
  id: string;
  status: Status;
  explanation: string;
  fix: string;
  tool?: string;
  input?: unknown;
  actual?: unknown;
  expected?: string;
  reproduction?: string;
}
export interface Target {
  stdio?: string;
  http?: string;
  sse?: boolean;
  headers: Record<string, string>;
  env: Record<string, string>;
  cwd?: string;
}
export interface Options {
  target: Target;
  timeout: number;
  maxDuration: number;
  latencyBudget: number;
  allowTool: string[];
  denyTool: string[];
  allowUnsafe: boolean;
  allowDestructive: boolean;
  yes: boolean;
  seed: number;
  tool?: string;
  runs: number;
  iterations: number;
  concurrency: number;
  secrets: string[];
}
export interface Inventory {
  server: unknown;
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  tools: Tool[];
  resources: any[];
  resourceTemplates: any[];
  prompts: any[];
}
export interface Benchmark {
  tool: string;
  calls: number;
  errors: number;
  errorRate: number;
  p50: number;
  p90: number;
  p99: number;
  throughput: number;
  durationMs: number;
}
export interface Report {
  command: string;
  target: string;
  seed: number;
  startedAt: string;
  durationMs: number;
  findings: Finding[];
  inventory?: Inventory;
  benchmarks?: Benchmark[];
  summary: Record<Status, number>;
  exitCode: 0 | 1 | 2 | 3;
}
export class UsageError extends Error {}
export class ConnectionError extends Error {}
