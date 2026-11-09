// Process fixture - real timers are required (ts-no-test-timers exception): the
// assertions observe a real broker-launched process, its real Unix socket and
// its persisted discovery sidecar, so fake timers cannot drive them. The awaited
// signals are file markers and socket frames, never fixed delays.
import * as fs from "node:fs";
import type { AgentSession } from "../../src/session/agent-session";
import {
	consumeSessionOwnerContext,
	SESSION_OWNER_CONTEXT_ENV,
	sessionOwnerContext,
} from "../../src/launch/session-owner";
import { createAgentSessionSocket } from "../../src/modes/rpc/rpc-socket";

const [endpointDir, reportFile] = process.argv.slice(2);
if (!endpointDir || !reportFile) throw new Error("usage: session-owner-child <endpointDir> <reportFile>");

const context = consumeSessionOwnerContext(process.env);
if (!context) throw new Error("session owner fixture requires the broker launch context");

const grandchild = Bun.spawn(
	[process.execPath, "-e", `process.stdout.write(process.env.${SESSION_OWNER_CONTEXT_ENV} ?? "absent")`],
	{ env: process.env, stdout: "pipe", stderr: "pipe" },
);
const grandchildEnv = (await new Response(grandchild.stdout).text()).trim();

const sessionId = Bun.env.FIXTURE_SESSION_ID ?? `sess-${process.pid}`;
const session = {
	sessionId,
	sessionFile: undefined,
	model: undefined,
	sessionManager: { getCwd: () => context.projectDir },
	subscribe: () => () => {},
} as unknown as AgentSession;

const socket = createAgentSessionSocket(session, { endpointDir });
await socket.listen(() => ({ dispatch: () => {} }));

const report = {
	pid: process.pid,
	context,
	liveContext: sessionOwnerContext(),
	endpoint: socket.endpoint,
	sidecarPath: socket.sidecarPath,
	sessionId,
	envConsumed: process.env[SESSION_OWNER_CONTEXT_ENV] === undefined,
	grandchildEnv,
};
fs.writeFileSync(reportFile, JSON.stringify(report));

const heartbeat = setInterval(() => process.stdout.write("OWNER_TICK\n"), 40);
let closing = false;
const shutdown = (): void => {
	if (closing) return;
	closing = true;
	clearInterval(heartbeat);
	void socket.close().finally(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
