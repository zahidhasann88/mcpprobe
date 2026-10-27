import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { parse } from "shell-quote";
import { StringDecoder } from "node:string_decoder";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import type { Target } from "./types.js";
import { UsageError } from "./types.js";
export interface Diagnostics {
  stderr: string[];
  stdoutErrors: string[];
  exit?: { code: number | null; signal: string | null };
  unexpectedExit?: boolean;
}
export function commandParts(command: string): string[] {
  const parts = parse(command, () => "");
  if (!parts.length || parts.some((p) => typeof p !== "string"))
    throw new UsageError(
      "Invalid stdio command: shell operators are not supported",
    );
  return parts as string[];
}
export class ObservedStdio implements Transport {
  onclose?: () => void;
  onerror?: (e: Error) => void;
  onmessage?: (m: JSONRPCMessage) => void;
  child?: ChildProcessWithoutNullStreams;
  diagnostics: Diagnostics = { stderr: [], stdoutErrors: [] };
  private buffer = "";
  private closing = false;
  private decoder = new StringDecoder("utf8");
  constructor(private target: Target) {}
  async start(): Promise<void> {
    const [command, ...args] = commandParts(this.target.stdio!);
    const inherited = Object.fromEntries(
      [
        "PATH",
        "HOME",
        "USER",
        "SHELL",
        "TERM",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
      ].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])),
    );
    const child = (this.child = spawn(command, args, {
      cwd: this.target.cwd,
      env: { ...inherited, ...this.target.env },
      stdio: "pipe",
    }));
    child.stderr.on("data", (chunk: Buffer) => {
      this.diagnostics.stderr.push(chunk.toString().slice(-8192));
      this.diagnostics.stderr = this.diagnostics.stderr.slice(-30);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += this.decoder.write(chunk);
      if (Buffer.byteLength(this.buffer) > 10 * 1024 * 1024) {
        this.invalid("stdout frame exceeded 10 MiB");
        this.buffer = "";
        return;
      }
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline).replace(/\r$/, "");
        this.buffer = this.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message?.id === null && "error" in message) delete message.id;
          this.onmessage?.(JSONRPCMessageSchema.parse(message));
        } catch {
          this.invalid(line.slice(0, 1024));
        }
      }
    });
    child.stdin.on("error", (e) => this.onerror?.(e));
    child.on("exit", (code, signal) => {
      if (this.buffer.trim()) this.invalid(this.buffer.slice(0, 1024));
      this.diagnostics.exit = { code, signal };
      this.diagnostics.unexpectedExit = !this.closing;
      this.onclose?.();
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }
  private invalid(line: string) {
    if (this.diagnostics.stdoutErrors.length < 20)
      this.diagnostics.stdoutErrors.push(line);
    this.onerror?.(new Error("Non-protocol stdout"));
  }
  async send(message: JSONRPCMessage): Promise<void> {
    await this.raw(JSON.stringify(message) + "\n");
  }
  async raw(frame: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (!this.child?.stdin.writable) {
        reject(new Error("Server stdin closed"));
        return;
      }
      this.child.stdin.write(frame, (e) => (e ? reject(e) : resolve()));
    });
  }
  async close(): Promise<void> {
    this.closing = true;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill("SIGKILL"), 500);
      kill.unref();
      child.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });
      child.stdin.end();
      child.kill("SIGTERM");
    });
  }
}
