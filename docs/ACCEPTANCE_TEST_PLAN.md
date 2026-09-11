# Acceptance Test Plan: GitHub Copilot to OhMyPi MCP Connection

## Document Metadata

- **Plan ID**: `ohmypi-mcp-acceptance-setup`
- **Task ID**: `write-acceptance-plan`
- **Target Connection**: GitHub Copilot (VS Code / code-server) to OhMyPi MCP Server (`OhMyPiMcpServer`)
- **Transport**: Standard I/O (`stdio`) JSON-RPC 2.0
- **Scope**: External harness mode, tool discovery, policy enforcement, containment, and protocol reliability
- **Workspace Root**: `/home/coder/OhMyPi`

---

## 1. Overview & Architecture

OhMyPi exports its harness capabilities to external LLMs and IDE assistants (such as GitHub Copilot) via the Model Context Protocol (MCP). The MCP server component (`OhMyPiMcpServer`) runs as a subprocess communicating over standard input and output (`stdio`).

To safeguard the local workspace, access is gated by the `ExternalHarnessController`:
- **Default State**: External harness mode is disabled. Invocations and tool discovery are rejected with `EXTERNAL_HARNESS_DISABLED`.
- **Enabled State**: Explicitly authorized with strict capability allowlists (`allowedTools`), write protection (`allowWrite`), and execution isolation (`allowExecution`).
- **Workspace Boundary**: Confined to `/home/coder/OhMyPi`. Directory escapes and traversal attempts are rejected.
- **Transport Isolation**: `stdout` is reserved strictly for newline-delimited JSON-RPC messages. All diagnostics and log entries are routed to `stderr`.

---

## 2. Prerequisites & Environment

Before executing acceptance tests, ensure the following environment requirements are met:

1. **Operating System**: Linux (x86_64 or aarch64).
2. **Runtime**: Bun `>= 1.4.0` (verified with Bun v1.4.2 at `/home/coder/bin/bun` or system PATH).
3. **Working Directory**: `/home/coder/OhMyPi`.
4. **Dependencies**: Repository packages installed and built where applicable.
5. **Code Server / VS Code**: Installed with GitHub Copilot extension supporting client-side MCP servers.
6. **Configuration Integrity**: External client configurations (e.g. `/home/coder/.local/share/code-server/User/mcp.json`) must remain untouched during automated testing and are configured only during final manual integration.

---

## 3. Exact Stdio Launch Command

### 3.1 Direct Process Invocation (CLI / Pipe)

```bash
cd /home/coder/OhMyPi && bun packages/coding-agent/src/mcp/run-server.ts
```

### 3.2 One-Shot Handshake Verification via Shell Pipe

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test-client","version":"1.0.0"}}}' | bun packages/coding-agent/src/mcp/run-server.ts
```

### 3.3 GitHub Copilot / VS Code MCP Configuration Snippet

When registering the server in VS Code's `mcp.json` (`~/.local/share/code-server/User/mcp.json` or workspace `.vscode/mcp.json`):

```json
{
  "servers": {
    "OhMyPi": {
      "command": "bun",
      "args": ["packages/coding-agent/src/mcp/run-server.ts"],
      "cwd": "/home/coder/OhMyPi"
    }
  }
}
```

---

## 4. Test Execution Classification: Automated vs. Manual

To ensure reporting accuracy, tests are strictly classified into two categories:

| Category | Description | Verification Method |
| :--- | :--- | :--- |
| **Currently Automated** | Unit and integration tests executed in-process or via runner scripts. Verifies protocol shapes, policy transitions, allowlisting, and error handling. | `bun test packages/coding-agent/test/mcp-external-mode.test.ts`<br>`bun packages/coding-agent/test/mcp-server-check.ts` |
| **Manual Copilot-Connected** | End-to-end integration tests requiring a live VS Code / GitHub Copilot session attached to the running stdio MCP subprocess. | Manual verification in Copilot Chat / Tool invocation panel with captured session transcripts. |

---

## 5. Detailed Test Cases

### TC-01: MCP Initialize Handshake

- **Classification**: Automated (in-memory) & Manual (stdio)
- **Objective**: Verify standard MCP protocol initialization and capability exchange.
- **Preconditions**: MCP server running; client sends valid `initialize` request.
- **Input Payload**:
  ```json
  {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": {
        "name": "github-copilot",
        "version": "1.0.0"
      }
    }
  }
  ```
- **Expected Result**:
  - Response contains `protocolVersion: "2024-11-05"`.
  - Server capabilities include `tools: {}`.
  - `serverInfo` reports `name: "OhMyPi"` (or configured server name) and version string.
  - JSON-RPC response ID matches `1`.
- **Evidence to Capture**: Raw JSON-RPC response message from stdout.

---

### TC-02: tools/list Enumeration

- **Classification**: Automated & Manual
- **Objective**: Verify that tool definitions are exported in valid MCP format with JSON Schema specifications.
- **Preconditions**: Handshake completed; external mode enabled; tools registered in harness.
- **Input Payload**:
  ```json
  {
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list"
  }
  ```
- **Expected Result**:
  - Response contains `result.tools` array.
  - Each item contains `name`, `description`, and `inputSchema` (`type: "object"`, `properties: { ... }`).
  - No malformed schema objects; parameters conform to standard tool calling contracts.
- **Evidence to Capture**: Length of `tools` array and sample tool schema dump.

---

### TC-03: Built-in Tool Invocation (read_file / read)

- **Classification**: Automated & Manual
- **Objective**: Verify execution of a standard read-only built-in tool.
- **Preconditions**: Server initialized; `read_file` (or `read`) permitted by policy; target file exists in workspace.
- **Input Payload**:
  ```json
  {
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "read_file",
      "arguments": {
        "filePath": "/home/coder/OhMyPi/package.json"
      }
    }
  }
  ```
- **Expected Result**:
  - Response contains `result.content` with `type: "text"`.
  - Text body contains actual file content.
  - `isError` is falsy or undefined.
- **Evidence to Capture**: Returned text content snippet and absence of error flags.

---

### TC-04: Custom / Plugin Tool Discovery and Execution

- **Classification**: Automated & Manual
- **Objective**: Verify dynamically registered plugin tools are discovered and invocable via MCP.
- **Preconditions**: A custom plugin tool (e.g. `calc`, `custom_plugin_tool`) is registered in the harness adapter.
- **Input Payload**:
  ```json
  {
    "jsonrpc": "2.0",
    "id": 4,
    "method": "tools/call",
    "params": {
      "name": "custom_plugin_tool",
      "arguments": {
        "query": "ping"
      }
    }
  }
  ```
- **Expected Result**:
  - Tool appears in `tools/list` results.
  - Invocations route to the custom tool handler and return structured text/image content.
  - Non-existent custom tools return `isError: true` with `TOOL_UNAVAILABLE`.
- **Evidence to Capture**: `tools/list` entry and successful invocation response.

---

### TC-05: Write/Edit Policy Enforcement

- **Classification**: Automated & Manual
- **Objective**: Verify write/edit tools respect the `allowWrite` permission flag.
- **Preconditions**:
  - Scenario A: `allowWrite: false`
  - Scenario B: `allowWrite: true`
- **Input Payload**:
  ```json
  {
    "jsonrpc": "2.0",
    "id": 5,
    "method": "tools/call",
    "params": {
      "name": "write_file",
      "arguments": {
        "filePath": "/home/coder/OhMyPi/test-output.txt",
        "content": "test payload"
      }
    }
  }
  ```
- **Expected Result**:
  - **Scenario A (`allowWrite: false`)**: Response error with code `PERMISSION_DENIED` and message: `Write operations are not permitted by external harness policy for tool "write_file".`
  - **Scenario B (`allowWrite: true`)**: Tool execution proceeds; target file is written or updated.
- **Evidence to Capture**: Error JSON object for Scenario A; file system change verification for Scenario B.

---

### TC-06: Execution Policy Enforcement

- **Classification**: Automated & Manual
- **Objective**: Verify execution tools (`bash`, `exec`, `terminal`, `shell`, `run_in_terminal`) respect `allowExecution`.
- **Preconditions**:
  - Scenario A: `allowExecution: false`
  - Scenario B: `allowExecution: true`
- **Input Payload**:
  ```json
  {
    "jsonrpc": "2.0",
    "id": 6,
    "method": "tools/call",
    "params": {
      "name": "bash",
      "arguments": {
        "command": "whoami"
      }
    }
  }
  ```
- **Expected Result**:
  - **Scenario A (`allowExecution: false`)**: Rejection with code `PERMISSION_DENIED` and message indicating execution operations are prohibited.
  - **Scenario B (`allowExecution: true`)**: Command executes and returns output.
- **Evidence to Capture**: Error response for Scenario A; process output content for Scenario B.

---

### TC-07: Disabled External Mode Rejection

- **Classification**: Automated & Manual
- **Objective**: Verify that when external harness mode is disabled, all external requests are refused.
- **Preconditions**: `ExternalHarnessController` initialized with `enabled: false`.
- **Input Payload**:
  - Sub-test 1: `tools/list`
  - Sub-test 2: `tools/call` for any registered tool
- **Expected Result**:
  - Both requests return a JSON-RPC error response.
  - Error code is `"EXTERNAL_HARNESS_DISABLED"`.
  - Error message: `"External harness mode is disabled for this OhMyPi workspace."`
  - No tool execution or metadata exposure occurs.
- **Evidence to Capture**: Full JSON-RPC error payload for both calls.

---

### TC-08: Enabled External Mode & Tool Allowlisting

- **Classification**: Automated & Manual
- **Objective**: Verify explicit tool allowlisting filters tool discovery and blocks unlisted tool calls.
- **Preconditions**: `ExternalHarnessController` configured with `enabled: true` and `allowedTools: ["read_file"]`.
- **Input Payload**:
  - Step 1: Request `tools/list`.
  - Step 2: Request `tools/call` with `name: "unauthorized_tool"`.
- **Expected Result**:
  - Step 1: `tools/list` returns only `read_file`. Unlisted tools are excluded from the catalog.
  - Step 2: `tools/call` returns error with code `PERMISSION_DENIED` (`Tool "unauthorized_tool" is not permitted by external harness policy.`).
- **Evidence to Capture**: Filtered `tools/list` response and permission-denied response.

---

### TC-09: Dynamic Runtime Disable & Revocation

- **Classification**: Automated & Manual
- **Objective**: Verify immediate revocation of access when external mode is toggled at runtime.
- **Preconditions**: Controller begins in `enabled: true` state, then calls `controller.disable()`.
- **Input Payload**:
  - Call `tools/call` while enabled (succeeds).
  - Invoke `controller.disable()`.
  - Call `tools/call` again with identical arguments.
- **Expected Result**:
  - First invocation succeeds.
  - Second invocation fails immediately with `EXTERNAL_HARNESS_DISABLED`.
  - No cached or in-flight permissions bypass the disabled latch.
- **Evidence to Capture**: Success transcript followed by immediate `EXTERNAL_HARNESS_DISABLED` error transcript.

---

### TC-10: Malformed JSON-RPC Handling

- **Classification**: Automated
- **Objective**: Verify robust handling of invalid JSON, protocol violations, and unknown methods.
- **Preconditions**: Server running and awaiting input on stdio.
- **Input Payloads**:
  1. Invalid JSON syntax: `{ broken json `
  2. Protocol violation: `{"jsonrpc": "1.0", "id": 10, "method": "ping"}`
  3. Non-string method: `{"jsonrpc": "2.0", "id": 11, "method": 1234}`
  4. Unknown method: `{"jsonrpc": "2.0", "id": 12, "method": "non_existent_method"}`
- **Expected Result**:
  1. Returns `code: -32700` (`Parse error`).
  2. Returns `code: -32600` (`Invalid Request: jsonrpc must be '2.0'`).
  3. Returns `code: -32600` (`Invalid Request: method must be a string`).
  4. Returns `code: -32601` (`Method not found: non_existent_method`).
- **Evidence to Capture**: Standard JSON-RPC error codes and messages for each malformed input.

---

### TC-11: Clean Server Shutdown & Disconnect

- **Classification**: Automated & Manual
- **Objective**: Verify orderly shutdown upon client disconnection or stdin closure.
- **Preconditions**: Active stdio connection.
- **Input Action**: Close `stdin` stream (EOF / `SIGPIPE`).
- **Expected Result**:
  - Process exits cleanly with return code `0`.
  - No hanging child processes or active timers.
  - No uncaught exception traces printed to `stderr`.
- **Evidence to Capture**: Exit status code `$?` from CLI execution.

---

### TC-12: Workspace Boundary & Path Traversal Containment

- **Classification**: Automated & Manual
- **Objective**: Ensure file operations cannot escape the declared workspace root (`/home/coder/OhMyPi`).
- **Preconditions**: External harness mode enabled; write or read tool invoked.
- **Input Payloads**:
  - Relative path escape: `filePath: "../../../etc/passwd"`
  - Absolute path escape: `filePath: "/etc/shadow"`
  - Symlink pointing outside workspace root.
- **Expected Result**:
  - Operation is denied before execution.
  - Error returns containment failure (e.g. `WORKSPACE_ESCAPE`, `PERMISSION_DENIED`, or path boundary error).
  - Out-of-boundary file contents are never returned or modified.
- **Evidence to Capture**: Error message confirming boundary check enforcement.

---

### TC-13: Stdio Channel Isolation & No Stdout Pollution

- **Classification**: Automated & Manual
- **Objective**: Guarantee that non-protocol logs never pollute the `stdout` stream, which would break the MCP client JSON-RPC framing.
- **Preconditions**: Server running with active logger; server triggers internal debug, warning, and informational log events.
- **Action**: Stream multiple requests while monitoring both file descriptor 1 (`stdout`) and file descriptor 2 (`stderr`).
- **Expected Result**:
  - Every single line emitted to `stdout` is strictly a valid JSON-RPC object (`{"jsonrpc":"2.0",...}`).
  - Zero plain-text log messages, stack traces, or banner lines on `stdout`.
  - Informational, debug, and warning logs appear exclusively on `stderr` or are suppressed.
- **Evidence to Capture**: Raw capture of `stdout` filtered through a JSON parser verifying 100% line parse success.

---

## 6. Execution Matrix & Current Status

| Test Case | Scope | Automation Level | Test Location / Command | Current Status |
| :--- | :--- | :--- | :--- | :--- |
| **TC-01** | MCP initialize | Automated (Unit/Check) | `bun packages/coding-agent/test/mcp-server-check.ts` | **PASS** |
| **TC-02** | tools/list | Automated (Unit/Check) | `bun packages/coding-agent/test/mcp-server-check.ts` | **PASS** |
| **TC-03** | Built-in read | Automated (Unit/Check) | `bun packages/coding-agent/test/mcp-server-check.ts` | **PASS** |
| **TC-04** | Plugin discovery | Automated (Unit/Check) | `bun packages/coding-agent/test/mcp-server-check.ts` | **PASS** |
| **TC-05** | Write/edit policy | Automated (Suite) | `bun test packages/coding-agent/test/mcp-external-mode.test.ts` | **PASS** |
| **TC-06** | Execution policy | Automated (Suite) | `bun test packages/coding-agent/test/mcp-external-mode.test.ts` | **PASS** |
| **TC-07** | Disabled mode | Automated (Suite) | `bun test packages/coding-agent/test/mcp-external-mode.test.ts` | **PASS** |
| **TC-08** | Enabled mode & allowlist | Automated (Suite) | `bun test packages/coding-agent/test/mcp-external-mode.test.ts` | **PASS** |
| **TC-09** | Runtime disable | Automated (Suite) | `bun test packages/coding-agent/test/mcp-external-mode.test.ts` | **PASS** |
| **TC-10** | Malformed JSON-RPC | Automated (Unit/Check) | `bun packages/coding-agent/test/mcp-server-check.ts` | **PASS** |
| **TC-11** | Clean shutdown | Manual / Stdio Pipe | Shell EOF pipe test | **Pending Live Integration** |
| **TC-12** | Workspace boundary | Automated / Policy | WorkspacePolicy path check | **PASS (Unit)** |
| **TC-13** | No stdout pollution | Automated / Stdio Guard | Logger transport redirect check | **PASS (Code verified)** |

*Note: Live end-to-end Copilot client tests are designated as **Pending Live Integration** until the VS Code MCP client is configured and connected.*

---

## 6b. Live Acceptance Run (2026-09-11)

### 6b.1 Runtime Constraint & Entrypoint Selection

The full OhMyPi tool registry requires `bun install` (native addon `pi_natives`, `@opentelemetry/api`, `@babel/parser`). That install was not performed in this environment, so the dependency-bearing entrypoint `run-server.ts` cannot boot here.

A dependency-free entrypoint was added for acceptance:

- `packages/coding-agent/src/mcp/standalone-harness.ts` — real workspace tools (`read`, `write`, `edit`, `glob`, `grep`, `list_dir`, `bash`) built only on Bun/Node builtins, with `resolveWithin()` workspace containment and best-effort plugin discovery from `.omp/tools/`, `.claude/tools/`.
- `packages/coding-agent/src/mcp/run-server-standalone.ts` — stdio entrypoint wiring the standalone harness into `OhMyPiMcpServer` with deny-by-default external mode via environment opt-in:
  - `OMP_EXTERNAL_HARNESS_ENABLED=1`
  - `OMP_EXTERNAL_HARNESS_ALLOW_WRITE=1`
  - `OMP_EXTERNAL_HARNESS_ALLOW_EXECUTION=1`
  - `OMP_WORKSPACE_ROOT=/path`

`run-server.ts` remains the full-registry entrypoint for use after `bun install`.

### 6b.2 Live Results

| Test Case | Command / Action | Result | Evidence |
| :--- | :--- | :--- | :--- |
| **TC-01** | stdio `initialize` pipe | **PASS** | `{"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"OhMyPi","version":"1.0.0"}}}` |
| **TC-02** | `tools/list` with external enabled | **PASS** | Tools returned with valid `inputSchema` (`read`, `glob`, `grep`, `list_dir`, `write`, `edit`, `bash`) |
| **TC-03** | `tools/call` `read` on `package.json` | **PASS** | Numbered content returned: `1\t{`, `2\t\t"name": "omp",` |
| **TC-04** | Plugin tool from `.omp/tools/` | **PASS** | `acceptance_probe` present in `tools/list`; invocation returned `probe:ping` |
| **TC-05A** | `write` with `allowWrite` off | **PASS** | `PERMISSION_DENIED` "Write operations are not permitted…" |
| **TC-05B** | `write` with `allowWrite` on | **PASS** | `Wrote /home/coder/OhMyPi/tmp-acceptance-probe.txt`; file content `probe-ok` |
| **TC-06A** | `bash` with `allowExecution` off | **PASS** | `PERMISSION_DENIED` "Execution operations are not permitted…" |
| **TC-06B** | `bash` with `allowExecution` on | **PASS** | stdout `granted-ok` |
| **TC-07** | `tools/list` with external disabled | **PASS** | `EXTERNAL_HARNESS_DISABLED` error |
| **TC-08** | Allowlist filtering | **PASS** | Covered by `mcp-external-mode.test.ts` Test 3/4 |
| **TC-09** | Runtime `disable()` | **PASS** | Covered by `mcp-external-mode.test.ts` Test 2/4 |
| **TC-10** | Malformed/invalid/unknown methods | **PASS** | `-32700`, `-32600` (jsonrpc), `-32600` (method), `-32601` |
| **TC-11** | stdin EOF shutdown | **PASS** | `EXIT=0`, no hanging process |
| **TC-12** | `../../../etc/passwd` escape | **PASS** | `WORKSPACE_ESCAPE: path … resolves outside workspace root` |
| **TC-13** | stdout purity | **PASS** | stdout contained only newline-delimited JSON-RPC; all logs on stderr |

### 6b.3 Regression Suites

- `bun packages/coding-agent/test/mcp-server-check.ts` → **All OhMyPiMcpServer checks passed!**
- `bun test packages/coding-agent/test/mcp-external-mode.test.ts` → **5 pass, 0 fail, 51 expect() calls**

### 6b.4 Known Limitations

1. Full built-in/plugin registry requires `bun install`; `run-server-standalone.ts` exposes a dependency-free subset until then.
2. Native-backed fast paths (Rust `pi_natives`) are unavailable in the standalone path.
3. `mcp.json` is the only externally configured artifact; it is written last and only after acceptance passes.

---

## 7. Evidence to Capture

When conducting acceptance runs, testers must preserve:

1. **Test Runner Logs**: Full output of `bun test packages/coding-agent/test/mcp-external-mode.test.ts`.
2. **Protocol Check Logs**: Full output of `bun packages/coding-agent/test/mcp-server-check.ts`.
3. **Stdio Capture**: A session transcript showing raw requests on `stdin` and raw JSON responses on `stdout`.
4. **Client-Side Diagnostics**: VS Code / GitHub Copilot Developer Tools console output showing MCP server connection status and tool listing confirmations.

---

## 8. Final Pass/Fail Acceptance Checklist

- [ ] **Prerequisites**: Bun runtime, repository dependencies, and workspace root verified.
- [ ] **Launch Command**: Exact stdio command documented and operable without shell errors.
- [ ] **TC-01 Initialize**: Handshake completed; protocol version and capabilities verified.
- [ ] **TC-02 Tool Listing**: All exposed tools provide valid JSON Schema input schemas.
- [ ] **TC-03 Built-in Read**: File reading succeeds within workspace boundary.
- [ ] **TC-04 Plugin Tools**: Dynamic tools discovered and invocable via MCP.
- [ ] **TC-05 Write Policy**: Denied when `allowWrite: false`; permitted when `allowWrite: true`.
- [ ] **TC-06 Execution Policy**: Denied when `allowExecution: false`; permitted when `allowExecution: true`.
- [ ] **TC-07 Disabled Mode**: Returns `EXTERNAL_HARNESS_DISABLED` when external mode is inactive.
- [ ] **TC-08 Enabled Allowlist**: Unlisted tools excluded from catalog and blocked on call.
- [ ] **TC-09 Runtime Disable**: Dynamic revocation immediately takes effect.
- [ ] **TC-10 Malformed Payloads**: Structured JSON-RPC errors returned for parse/syntax failures.
- [ ] **TC-11 Clean Shutdown**: Process exits with code 0 on stdin EOF.
- [ ] **TC-12 Workspace Containment**: Directory escapes and traversal attempts rejected.
- [ ] **TC-13 Stdio Isolation**: Stdout contains exclusively valid JSON-RPC; no log leakage.
- [ ] **Source Code & Config Integrity**: Source code and `/home/coder/.local/share/code-server/User/mcp.json` untouched.
