# mcpprobe

**Postman plus a fuzzer for MCP servers.**

mcpprobe connects to a [Model Context Protocol](https://modelcontextprotocol.io) server, lists everything it offers, calls its tools with generated and edge-case inputs, and reports crashes, protocol violations and slow calls.

- Works over **stdio**, **Streamable HTTP** and legacy **SSE**
- **Safe by default**: only calls tools marked read-only
- **Reproducible**: every run prints a seed, and every failure includes a `mcpprobe call ...` command to reproduce it
- Reports for the **console**, **JSON**, **JUnit**, **Markdown** and **SARIF**
- Usable as a **CLI** or as a **library**

Requires Node.js 20+.

## Quick start

```sh
git clone <this-repo> && cd mcpprobe
pnpm install
pnpm build
npm link          # makes the `mcpprobe` command available everywhere

mcpprobe inspect --stdio "node ./server.js"
```

To remove the command later, run `npm unlink -g mcpprobe`.

## Commands

| Command | What it does |
|---|---|
| `inspect` | Connect and show server info, capabilities, tools, resources and prompts |
| `test` | Run the full check suite and print a report |
| `fuzz` | Send many generated inputs to tools and shrink any failure to a minimal input |
| `bench` | Call tools repeatedly and report p50/p90/p99 latency, error rate and throughput |
| `call` | Call one tool by hand and print the raw result |

```sh
# Connect to a local server (stdio) or a remote one (HTTP)
mcpprobe inspect --stdio "node ./server.js"
mcpprobe inspect --http https://host/mcp --header "Authorization: Bearer $TOKEN"

# Test, fuzz and benchmark
mcpprobe test  --stdio "node ./server.js"
mcpprobe fuzz  --stdio "node ./server.js" --tool search --runs 200 --seed 42
mcpprobe bench --stdio "node ./server.js" --tool search --iterations 100 --concurrency 4

# Call a tool by hand
mcpprobe call search --stdio "node ./server.js" --args '{"query":"hello"}'
```

### Common options

| Option | Default | Description |
|---|---|---|
| `--tool <name>` | all tools | Only test this tool |
| `--seed <n>` | `424242` | Seed for generated inputs |
| `--timeout <ms>` | `15000` | Timeout for each call |
| `--max-duration <ms>` | `120000` | Time limit for the whole run |
| `--latency-budget <ms>` | `2000` | Calls slower than this produce a warning |
| `--format <type>` | `console` | `console`, `json`, `junit`, `markdown` or `sarif` |
| `--json` | | Same as `--format json` |
| `--out <file>` | | Write the report to a file instead of the terminal |
| `--strict` | | Treat warnings as failures |
| `--config <file>` | | Use a config file |
| `--target <name>` | | Use a target defined in the config file |

Run `mcpprobe <command> --help` for the full list.

## Safety model

mcpprobe will **not** call a tool unless it is known to be safe. A tool is called only when one of these is true:

1. It is annotated `readOnlyHint: true`, **or**
2. You allow it explicitly with `--allow-tool <name>`.

All other tools are skipped and appear in the report as `skipped (not known to be safe)`.

| Flag | Effect |
|---|---|
| `--allow-tool <name>` | Allow a specific tool |
| `--deny-tool <name>` | Never call this tool (overrides everything else) |
| `--allow-unsafe` | Allow tools that have no annotations |
| `--allow-destructive` | Allow tools annotated `destructiveHint: true` (a separate flag, on purpose) |
| `--yes` | Confirm `--allow-unsafe` or `--allow-destructive` without a prompt (required in CI) |

Additional safeguards:

- Resources are only read and prompts are only fetched. Nothing is written or executed.
- The stdio command runs **without a shell**, so pipes and redirects are not supported.
- Secrets (tokens, headers, env values) are replaced with `[REDACTED]` in all output.

> Tool annotations are claims made by the server, not guarantees. Test against a disposable server with fake data.

## Configuration

mcpprobe automatically loads `mcpprobe.config.json` or `mcpprobe.config.yaml` from the current directory. Command-line flags override the config file.

```yaml
defaultTarget: local
timeout: 15000
allowTool: [lookup_record]
denyTool: [delete_everything]
targets:
  local:
    stdio: "node ./server.js"
    env:
      API_TOKEN: "${TOKEN}"     # read from your environment
  staging:
    http: https://host/mcp
    headers:
      Authorization: "Bearer ${TOKEN}"
```

See [mcpprobe.config.example.yaml](mcpprobe.config.example.yaml) for a full example. Don't commit real credentials; use `${VAR}` placeholders instead.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Every check passed (warnings are allowed unless `--strict` is set) |
| `1` | At least one check failed |
| `2` | Usage or config error |
| `3` | Could not connect to the server |

## Check catalog

Each check reports **pass**, **warn**, **fail** or **skipped**, with a stable ID and a hint on how to fix it.

**Protocol and lifecycle**

| ID | Checks that... |
|---|---|
| `INITIALIZE` | The initialize handshake succeeds within the timeout |
| `PROTOCOL_VERSION` | The negotiated protocol version is supported |
| `PROTOCOL_NEGOTIATION` | The server picks a supported version when asked for an unknown one (stdio only) |
| `CAPABILITY_MATCH` | Every declared capability actually works, and its list results can be fully paged through |
| `PREINITIALIZE` | Requests sent before initialize don't crash or hang the server (stdio only) |
| `UNKNOWN_METHOD` | Unknown methods return JSON-RPC error `-32601` |
| `MALFORMED_JSONRPC` | Bad JSON is rejected and the server keeps running (stdio only) |
| `WRONG_PARAMS` | Wrongly typed parameters are rejected and the server keeps running (stdio only) |
| `RAW_STDIO` | Low-level stdio probes ran successfully (skipped over HTTP) |
| `PROCESS_EXIT` | The server process didn't exit unexpectedly (the report includes the exit code and last stderr lines) |
| `STDOUT_PURITY` | Nothing but protocol messages is written to stdout (catches stray `console.log`) |

**Tools**

| ID | Checks that... |
|---|---|
| `TOOL_NAME` | Tool names are present and unique |
| `TOOL_DESCRIPTION` | Each tool has a description (warn) |
| `TOOL_VAGUE_NAME` | Names aren't vague, like `run` or `tool1` (warn) |
| `INPUT_SCHEMA` | `inputSchema` is a valid JSON Schema |
| `SCHEMA_DOCUMENTATION` | Input properties have descriptions (warn) |
| `OUTPUT_SCHEMA` | `structuredContent` matches the declared `outputSchema` |
| `VALID_INPUT` | Valid input returns a result, not a protocol error |
| `INVALID_INPUT` | Invalid input is clearly rejected, without a crash, hang or success |
| `ERROR_LEAK` | Responses contain no stack traces, local file paths or secrets |
| `READONLY_DETERMINISM` | Read-only tools return the same result for the same input (warn) |
| `CALL_TIMEOUT` | Calls finish within the timeout |
| `TOOL_LATENCY` | Calls finish within the latency budget (warn) |

**Resources and prompts**

| ID | Checks that... |
|---|---|
| `RESOURCE_READ` | Listed resources can be read |
| `RESOURCE_TEMPLATE` | URI templates expand to readable resources |
| `RESOURCE_MIME` | Resources include a MIME type (warn) |
| `UNKNOWN_RESOURCE` | Unknown URIs return a proper error |
| `PROMPT_GET` | Listed prompts return valid messages |

**Run-level**

| ID | Meaning |
|---|---|
| `SAFETY_SKIP` | A tool was skipped by the safety rules |
| `SAFETY_OVERRIDE` | `--allow-unsafe` or `--allow-destructive` is on (warn) |
| `TOOL_SELECTION` | The tool named with `--tool` doesn't exist |
| `INPUT_GENERATION` | No valid input could be generated from the schema (warn) |
| `GLOBAL_BUDGET` | The run hit `--max-duration` before finishing (warn) |
| `FUZZ_RUNS` / `FUZZ_FAILURE` | Fuzzing passed, or found a failing input (shrunk to a minimal example) |
| `BENCH_ERRORS` | Benchmark calls returned errors |
| `MANUAL_CALL` | Result of a `call` command |

## CI usage (GitHub Actions)

```yaml
- uses: pnpm/action-setup@v4
- uses: actions/setup-node@v4
  with:
    node-version: 22
- run: pnpm install --frozen-lockfile && pnpm build
- run: npm link && mcpprobe test --stdio "node ./server.js" --format junit --out junit.xml
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: mcpprobe-report
    path: junit.xml
```

## Library usage

```ts
import { resolveOptions, testServer, formatReport } from "mcpprobe";

const options = resolveOptions({}, { stdio: "node ./server.js", seed: 42 });
const report = await testServer(options);

console.log(formatReport(report, "markdown"));
process.exitCode = report.exitCode;
```

The library also exports `inspect`, `fuzz`, `bench` and `callTool`. These functions return report objects and never print anything or exit the process.

## Development

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build

# Run the CLI from source without rebuilding
pnpm dev inspect --stdio "node ./server.js"
```

```
src/core/                core library: connection, checks, input generators, safety, reports
src/cli/                 command-line interface
test/fixtures/servers/   small MCP test servers, each with one deliberate bug
```

## License

MIT. See [CHANGELOG.md](CHANGELOG.md) for release history.
