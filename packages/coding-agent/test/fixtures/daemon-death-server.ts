// Child-process fixture for daemon death-recovery tests.
//
// Runs a real DaemonServer (fake session runtimes) in a separate process so a
// test can SIGKILL it — a true crash that leaves the socket file and owner
// lease stale on disk, unlike an in-process `shutdown(true)`.
//
// argv: <runtimeDir> <token>
// stdout: "READY <endpoint>\n" once the listener is bound.
import { DaemonServer } from "../../src/daemon/server";
import type { DaemonSessionRuntime, DaemonSessionSnapshot } from "../../src/daemon/session-runtime";
import type { AgentSessionEventListener } from "../../src/session/agent-session";

const [runtimeDir, token] = Bun.argv.slice(2);
if (!runtimeDir || !token) {
	process.stderr.write("usage: daemon-death-server.ts <runtimeDir> <token>\n");
	process.exit(2);
}

const runtimeFactory = async ({
	cwd,
	sessionId,
}: {
	cwd: string;
	sessionId?: string;
}): Promise<DaemonSessionRuntime> => {
	const id = sessionId ?? crypto.randomUUID();
	const listeners = new Set<AgentSessionEventListener>();
	const commands: string[] = [];
	const session: DaemonSessionRuntime["session"] = {
		sessionId: id,
		isStreaming: false,
		prompt: async () => true,
		abort: async () => undefined,
		dispose: async () => undefined,
		subscribe: (listener: AgentSessionEventListener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	return {
		sessionId: id,
		cwd,
		session,
		protectedJobCount: () => 0,
		snapshot: (): DaemonSessionSnapshot => ({
			state: {
				sessionId: id,
				thinkingLevel: undefined,
				isStreaming: false,
				fastModeEnabled: false,
				fastModeActive: false,
				tokensPerSecond: null,
				isCompacting: false,
				steeringMode: "all",
				followUpMode: "all",
				interruptMode: "immediate",
				autoCompactionEnabled: true,
				messageCount: commands.length,
				queuedMessageCount: 0,
				todoPhases: [],
			},
			cwd,
			entries: [],
		}),
		command: async command => {
			commands.push(JSON.stringify(command));
			return { accepted: true };
		},
		dispose: reason => session.dispose(reason === undefined ? undefined : { reason }),
		subscribe: session.subscribe,
	};
};

const server = new DaemonServer({
	profile: "test",
	runtimeDir,
	token,
	runtimeFactory,
	ownerProcessVerifier: () => true,
});
await server.run();
process.stdout.write(`READY ${server.endpoint}\n`);
// Stay alive until killed.
const { promise } = Promise.withResolvers<void>();
await promise;
