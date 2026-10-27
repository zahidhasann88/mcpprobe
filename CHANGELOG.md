# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-10-27

### Breaking

- Requires Node.js 22.12 or later (previously 20). Node.js 20 is end-of-life, and the updated `commander` dependency needs 22.12.

### Added

- `mcpprobe run <file>`: run scenarios from a YAML/JSON file. Each step calls a tool, reads a resource or gets a prompt, and can check `contains`, `notContains`, `matches`, `isError`, `structured`, `error`, `errorCode` and `maxMs`. Library: `runScenarios`, `loadScenarios`.
- `mcpprobe snapshot <file>` and `mcpprobe diff <baseline> [current]`: save the server inventory and fail on breaking changes, such as removed tools, new required inputs, tighter limits or removed outputs. Warns when a tool stops being read-only or a description changes. Library: `diff`, `diffSnapshots`, `diffInventories`, `loadSnapshot`.
- Tool poisoning check (`TOOL_POISONING`): flags invisible Unicode, instruction tags, attempts to override instructions or hide things from the user, sensitive file references and requests for credentials in any description or schema text. Overly long descriptions are reported as `DESCRIPTION_LENGTH`.
- HTTP security checks for Streamable HTTP targets: Origin validation (`HTTP_ORIGIN`), access without configured credentials (`HTTP_AUTH`), session ID handling (`HTTP_SESSION`) and unsupported `MCP-Protocol-Version` headers (`HTTP_PROTOCOL_VERSION`).
- Progress ordering (`PROGRESS`) and behavior after a cancelled request (`CANCELLATION`).
- Checks for `ping`, `logging/setLevel`, `completion/complete` and resource subscriptions, each run only when the server declares the capability, plus validation of every notification the server sends (`NOTIFICATIONS`).

### Changed

- Inputs are now generated with json-schema-faker 0.6, so a given `--seed` produces different inputs than in 0.1.0. Seeds still reproduce runs within the same version.
- `--version`, the client info sent to servers and SARIF reports now use the package version.

### Fixed

- Servers that answer malformed JSON with `"id": null`, as JSON-RPC 2.0 requires, no longer fail `MALFORMED_JSONRPC` and `STDOUT_PURITY`.

### Security

- Updated dependencies to resolve all `pnpm audit` advisories, including zod (GHSA-mrhx-c7xc-m3w5), body-parser (GHSA-27r3-jxmh-p828) and fast-uri, which ship with the package.

## [0.1.0] - 2026-10-16

### Added

- ESM TypeScript CLI and importable library for Node.js 20 or later.
- Official MCP SDK client with an observed stdio transport, Streamable HTTP and legacy SSE.
- Paginated inspection; protocol, schema, input, output, latency and leak checks.
- Separate consent gates for unsafe and destructive tools, with deny-list precedence.
- Seeded JSON Schema input generation, inert hostile inputs and fast-check shrinking.
- Concurrent benchmarks; console, JSON, JUnit, Markdown and SARIF reports.
- Tag-driven npm release workflow with provenance.

[0.2.0]: https://github.com/zahidhasann88/mcpprobe/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/zahidhasann88/mcpprobe/releases/tag/v0.1.0
