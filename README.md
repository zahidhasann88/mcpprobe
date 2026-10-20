# mcpprobe

**Test your MCP server before your users do.**

mcpprobe connects to a [Model Context Protocol](https://modelcontextprotocol.io) server, looks at everything it offers, calls its tools with normal and tricky inputs, and tells you what broke: crashes, protocol mistakes, leaked secrets and slow calls.

Works with local servers (stdio) and remote ones (HTTP / SSE). Requires Node.js 20+.

## How it works

1. **Connect** – starts your server (or connects to its URL) and does the normal MCP handshake, just like a real AI client would.
2. **Discover** – lists all tools, resources and prompts the server offers.
3. **Pick safe tools** – keeps only tools marked read-only (unless you allow more).
4. **Call them** – builds inputs from each tool's schema: valid ones, broken ones, and random ones. It also sends bad protocol messages on purpose.
5. **Report** – checks every response and prints pass / warn / fail, with a fix hint and a command to reproduce each problem.

Random inputs come from a seed, so running the same seed again gives exactly the same test.

## Install

```sh
npm install -g @zahid15/mcpprobe
```

Or run it without installing:

```sh
npx @zahid15/mcpprobe inspect --stdio "node ./server.js"
```

## Usage

```sh
# See what the server offers
mcpprobe inspect --stdio "node ./server.js"

# Run all checks and get a pass/fail report
mcpprobe test --stdio "node ./server.js"

# Send lots of random inputs to one tool
mcpprobe fuzz --stdio "node ./server.js" --tool search

# Measure speed
mcpprobe bench --stdio "node ./server.js" --tool search

# Call a tool by hand
mcpprobe call search --stdio "node ./server.js" --args '{"query":"hello"}'
```

For a remote server, use `--http` instead of `--stdio`:

```sh
mcpprobe test --http https://host/mcp --header "Authorization: Bearer $TOKEN"
```

Run `mcpprobe <command> --help` to see all options.

### Useful options

| Option | What it does |
|---|---|
| `--tool <name>` | Only test this tool |
| `--format <type>` | Report as `console`, `json`, `junit`, `markdown` or `sarif` |
| `--out <file>` | Save the report to a file |
| `--seed <n>` | Repeat the exact same random inputs |
| `--strict` | Treat warnings as failures |

## Safe by default

mcpprobe only calls tools that say they are **read-only**. Everything else is skipped, so it won't delete or change your data by accident.

To call other tools, allow them yourself:

| Flag | What it does |
|---|---|
| `--allow-tool <name>` | Allow one specific tool |
| `--deny-tool <name>` | Never call this tool |
| `--allow-unsafe` | Allow tools that don't say whether they are safe |
| `--allow-destructive` | Allow tools marked as destructive |
| `--yes` | Skip the confirmation prompt (needed in CI) |

Secrets like tokens and headers are always hidden as `[REDACTED]` in the output.

> A server can mislabel its tools. Always test against a throwaway server with fake data.

## Config file (optional)

Instead of typing the same flags every time, create `mcpprobe.config.yaml` in your project:

```yaml
defaultTarget: local
allowTool: [lookup_record]
targets:
  local:
    stdio: "node ./server.js"
  staging:
    http: https://host/mcp
    headers:
      Authorization: "Bearer ${TOKEN}"   # read from your environment
```

Then just run `mcpprobe test`. See [mcpprobe.config.example.yaml](mcpprobe.config.example.yaml) for every option.

## What it checks

- **Protocol** – the handshake works, unknown or broken requests get proper errors, and the server doesn't crash or print junk to stdout.
- **Tools** – names, descriptions and schemas are valid; good input works; bad input is rejected cleanly; responses don't leak stack traces, file paths or secrets; calls aren't too slow.
- **Resources and prompts** – everything listed can actually be read.

Every failure comes with a hint on how to fix it and a `mcpprobe call ...` command to reproduce it.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | All checks passed |
| `1` | Some checks failed |
| `2` | Wrong command or config |
| `3` | Couldn't connect to the server |

## Use in CI

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 22
- run: npx @zahid15/mcpprobe test --stdio "node ./server.js" --format junit --out junit.xml
```

## Use as a library

```ts
import { resolveOptions, testServer, formatReport } from "@zahid15/mcpprobe";

const report = await testServer(resolveOptions({}, { stdio: "node ./server.js" }));
console.log(formatReport(report, "markdown"));
```

## Contributing

```sh
pnpm install
pnpm test
pnpm dev inspect --stdio "node ./server.js"   # run from source
```

## License

MIT
