import * as stream from "node:stream";
import { postmortem } from "@oh-my-pi/pi-utils";
import { AgentSideConnection, ndJsonStream, type Stream } from "@oh-my-pi/pi-utils/acp";
import type { ExtensionUIContext } from "../../extensibility/extensions/types";
import type { AgentSession } from "../../session/agent-session";
import { AcpAgent } from "./acp-agent";

/** Session and deferred tool UI hook created for an ACP client workspace. */
export interface AcpSessionHandle {
	session: AgentSession;
	setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
}

/**
 * Creates sessions requested by an ACP client.
 *
 * Session-only results remain supported for embedders that do not need the
 * deferred interactive-prompt bridge.
 */
export type AcpSessionFactory = (
	cwd: string,
	options?: { interactivePrompts?: boolean },
) => Promise<AgentSession | AcpSessionHandle>;

/** Creates an ACP connection and exposes its agent when process-level teardown must own it. */
export function createAcpConnection(
	transport: Stream,
	createSession: AcpSessionFactory,
	initialSession?: AgentSession,
	onAgent?: (agent: AcpAgent) => void,
): AgentSideConnection {
	return new AgentSideConnection(connection => {
		const agent = new AcpAgent(connection, createSession, initialSession);
		onAgent?.(agent);
		return agent;
	}, transport);
}

/** Serves ACP over stdio until the peer disconnects, then awaits session teardown before exit. */
export async function runAcpMode(createSession: AcpSessionFactory, initialSession?: AgentSession): Promise<void> {
	// Humans who run `omp acp` by hand see a silent process and assume it is
	// broken (stdout is the JSON-RPC transport, so nothing may be printed
	// there). When stdin is a TTY no ACP client is attached — say so on stderr
	// before the transport starts.
	if (process.stdin.isTTY) {
		process.stderr.write(
			"omp acp: ACP server speaking JSON-RPC over stdio.\n" +
				'This command is meant to be spawned by an ACP client (e.g. Zed\'s "agent_servers" config), not run directly.\n' +
				"Waiting for protocol frames on stdin; logs: ~/.omp/logs/\n",
		);
	}
	let agent: AcpAgent | undefined;
	postmortem.register("acp-session-teardown", reason => agent?.dispose(reason));
	postmortem.registerStdioDisconnectHandling();
	const input = stream.Writable.toWeb(process.stdout);
	const output = stream.Readable.toWeb(process.stdin);
	const transport = ndJsonStream(input, output);
	const connection = createAcpConnection(transport, createSession, initialSession, createdAgent => {
		agent = createdAgent;
	});
	await connection.closed;
	await postmortem.quit(0);
}
