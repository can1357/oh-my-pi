/**
 * Servers whose tools connect but stay out of the initial active set and the
 * `xd://` inventory until a prompt hook names them.
 *
 * `contextforge` is the shared broker. `contextforge-upstream` and
 * `capability-meta` stay in mcp.json for the broker, but they are not
 * model-facing. `agentmux` is not in this set: it stays connected and active
 * until it is eliminated, including `run_command`.
 */
export const DEFAULT_DEFERRED_MCP_SERVERS: readonly string[] = [
  "contextforge",
  "contextforge-upstream",
  "capability-meta",
];

/** Whether a server's tools register inactive. An explicit config flag wins over the name default. */
export function isDeferredMCPServer(name: string, deferred?: boolean): boolean {
  if (deferred === true) return true;
  if (deferred === false) return false;
  return DEFAULT_DEFERRED_MCP_SERVERS.includes(name);
}

/** A tool is deferred when its flag says so, or when its server name defaults deferred and the flag is absent. */
export function isDeferredMCPTool(tool: { mcpServerName?: unknown; mcpDeferred?: unknown }): boolean {
  if (tool.mcpDeferred === true) return true;
  if (tool.mcpDeferred === false) return false;
  return typeof tool.mcpServerName === "string" && isDeferredMCPServer(tool.mcpServerName);
}
