import * as stream from "node:stream";
import { inspect } from "node:util";
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

/**
 * Redirects stray stdout traffic to stderr so it can never corrupt the JSON-RPC channel.
 */
function isolateProtocolStdout(): NodeJS.WriteStream {
	// fd 1 is the JSON-RPC transport — the same invariant rpc-mode guards by
	// suppressing notifications. Extensions, dependencies, and console.log all
	// target process.stdout; a single OSC title or BEL spliced into the stream
	// desyncs frame parsing and the client times out. Capture the real stdout
	// for the transport, then detour every other writer to stderr.
	const protocolStdout = process.stdout;
	const stderrSink = new stream.Writable({
		write(chunk, _encoding, callback) {
			process.stderr.write(chunk, callback);
		},
	}) as unknown as NodeJS.WriteStream;
	Object.defineProperty(process, "stdout", { value: stderrSink, configurable: true, writable: true });
	// Node's bootstrap console bound to the original stdout object; rebind so
	// extension console.log calls are detoured away from fd 1 as well.
	(globalThis.console as unknown as { log: (...args: unknown[]) => void }).log = (...args) =>
		process.stderr.write(`${formatConsoleArgs(args)}\n`);
	return protocolStdout;
}

function formatConsoleArgs(args: unknown[]): string {
	return args
		.map(arg => {
			if (typeof arg === "string") return arg;
			if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
			return inspect(arg, { depth: 2, breakLength: 120 });
		})
		.join(" ");
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
	const input = stream.Writable.toWeb(isolateProtocolStdout());
	const output = stream.Readable.toWeb(process.stdin);
	const transport = ndJsonStream(input, output);
	const connection = createAcpConnection(transport, createSession, initialSession, createdAgent => {
		agent = createdAgent;
	});
	await connection.closed;
	await postmortem.quit(0);
}
