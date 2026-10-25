import { CAPABILITY_SERVER_NAME, CAPABILITY_WAIT_TOOL_NAME } from "../discovery/capability-server";
import { createMCPToolName } from "../mcp/tool-bridge";
import type { ToolSession } from ".";

/** The minted MCP name the capability server's wait tool carries. */
const CAPABILITY_WAIT_MINTED_NAME = createMCPToolName(CAPABILITY_SERVER_NAME, CAPABILITY_WAIT_TOOL_NAME);

/**
 * Whether the session can call the capability wait — the MCP tool that
 * replaced the built-in `wait` — so prompts point blocked callers at it only
 * when it is actually mounted.
 */
export function hasCapabilityWaitTool(session: ToolSession): boolean {
	return session.toolRegistry?.has(CAPABILITY_WAIT_MINTED_NAME) ?? false;
}
