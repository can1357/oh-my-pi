/**
 * The one decision on whether this process may start MCP servers.
 *
 * `--no-mcp` and its environment form `PI_NO_MCP=1` mean "start no MCP server":
 * none from user, project or plugin config, and none a caller supplies
 * explicitly (an ACP client's `mcpServers`, an SDK host's `connectServers`).
 * The two points every start goes through, `connectToServer` and the
 * manager's config resolution (which runs `!command` values), refuse while it
 * is in effect; bulk startup paths check {@link isMCPDisabled} to skip quietly.
 * Every process omp starts inherits the choice through `PI_NO_MCP=1`.
 */
import { $flag, setInheritedEnv } from "@oh-my-pi/pi-utils";

const NO_MCP_ENV = "PI_NO_MCP";

/** The CLI flag that turns MCP off; also what omp passes to an omp it relaunches. */
export const NO_MCP_FLAG = "--no-mcp";

/**
 * Whether MCP is off for this process. While it is, the value is pinned as one
 * this process owns, so every child inherits `PI_NO_MCP=1` whatever a project
 * dotenv file says.
 */
export function isMCPDisabled(): boolean {
	if (!$flag(NO_MCP_ENV)) return false;
	setInheritedEnv(NO_MCP_ENV, "1");
	return true;
}

/** Apply `--no-mcp`: turn MCP off for this process and every process it starts. */
export function disableMCP(): void {
	setInheritedEnv(NO_MCP_ENV, "1");
}

/** Thrown where a server would start while MCP is off. */
export class MCPDisabledError extends Error {
	readonly serverName: string | undefined;

	constructor(serverName?: string) {
		super(
			serverName === undefined
				? "MCP is disabled (--no-mcp or PI_NO_MCP=1): no MCP server is started."
				: `MCP server "${serverName}" was not started: MCP is disabled (--no-mcp or PI_NO_MCP=1).`,
		);
		this.name = "MCPDisabledError";
		this.serverName = serverName;
	}
}

/** Throw {@link MCPDisabledError} while MCP is off. */
export function assertMCPEnabled(serverName?: string): void {
	if (isMCPDisabled()) throw new MCPDisabledError(serverName);
}

/**
 * Arguments that carry the MCP choice to another omp built from `argv`:
 * `["--no-mcp"]` while MCP is off and `argv` lacks it, else none. Prepend them,
 * so the flag sits in the leading global segment the CLI router reads.
 */
export function mcpPolicyArgs(argv: readonly string[]): string[] {
	return isMCPDisabled() && !argv.includes(NO_MCP_FLAG) ? [NO_MCP_FLAG] : [];
}
