/**
 * The one decision on whether this process may start MCP servers.
 *
 * `--no-mcp` and its environment form `PI_NO_MCP=1` mean "start no MCP server":
 * none from user, project or plugin config, and none a caller supplies
 * explicitly (an ACP client's `mcpServers`, an SDK host's `connectServers`).
 * Every start refuses while it is in effect: `connectToServer`, each transport's
 * `connect`, and the manager's config resolution (which runs `!command`
 * values). Discovery and bulk startup check {@link isMCPDisabled} to skip
 * quietly.
 * Every process omp starts inherits the choice through `PI_NO_MCP=1`.
 *
 * The choice is made once, at startup: `PI_NO_MCP=1` in the launch environment,
 * or `--no-mcp`, which the CLI applies ({@link disableMCP}) before it starts
 * anything. It is not a switch for a running process: a shell, worker,
 * connection or cached environment that already exists keeps the choice it was
 * made with.
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

/**
 * Apply `--no-mcp`: turn MCP off for this process and every process it starts.
 * Call it at startup, before anything is started (see the module comment).
 */
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

/**
 * Whether a server start (a transport, a connect, a config value resolved for
 * one) is refused. While MCP is off it always is. Kept apart from
 * {@link isMCPDisabled}, which also governs discovery of configured servers, so
 * a test that starts stub servers it builds itself can lift only this check:
 * discovery then stays off and cannot pick up the developer's own servers.
 */
export function refusesMCPServerStarts(): boolean {
	return isMCPDisabled();
}

/** Throw {@link MCPDisabledError} where a server would start while MCP is off. */
export function assertMCPEnabled(serverName?: string): void {
	if (refusesMCPServerStarts()) throw new MCPDisabledError(serverName);
}

/**
 * Arguments that carry the MCP choice to another omp: `["--no-mcp"]` while MCP
 * is off, else none. Always prepended, never inferred from the argv it joins:
 * a `--no-mcp` already there may be another flag's value (`--system-prompt
 * --no-mcp`). A repeated flag is harmless.
 */
export function mcpPolicyArgs(): string[] {
	return isMCPDisabled() ? [NO_MCP_FLAG] : [];
}

/**
 * The MCP choice as environment for a process a shared, long-lived host starts
 * on this session's behalf: the launch broker (and every daemon it runs), the
 * LSP mux, the IDA host, the blob broker. A host's own environment belongs to
 * whichever session started it, so the requester's choice travels with each
 * request that can make the host start a process, both ways.
 *
 * `env` is the request's own environment: an explicit `PI_NO_MCP=1` in it
 * stays, but it can never turn MCP back on while this session has it off.
 */
export function mcpPolicyEnv(env?: Readonly<Record<string, string>>): Record<string, string> {
	return isMCPDisabled() ? { ...env, [NO_MCP_ENV]: "1" } : { [NO_MCP_ENV]: "", ...env };
}
