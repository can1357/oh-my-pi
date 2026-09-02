/**
 * Wire contract for active-turn steering.
 *
 * A host that drives a session over RPC cannot see the turn boundary the way the
 * TUI can, so two commands exist for it:
 *  - `steer` with `activeTurnOnly: true` answers `data.accepted`, rejecting when
 *    no turn is live at the server's enqueue boundary instead of seeding the idle
 *    queue (which auto-drains into an unrequested turn).
 *  - `clear_queue` with `forInterrupt: true` is acknowledged only after the
 *    queues have been replaced, so a following `abort` is not undone by the
 *    server's stranded-queue drain.
 *
 * Both are gated by `ready.features.activeTurnSteering === 1`, which the server
 * advertises in the v1 ready frame — before and independently of any v2
 * negotiation.
 *
 * Server-side queue semantics are pinned in
 * `agent-session-active-turn-steer.test.ts`; this file pins the wire.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type RpcAgentProcess, RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const CLI_DIR = path.join(import.meta.dir, "..");
const CLI_PATH = path.join(CLI_DIR, "src", "cli.ts");

interface FakeRpcServer {
	process: RpcAgentProcess;
	/** Every command envelope the client wrote, in order. */
	received: Record<string, unknown>[];
}

/**
 * In-process RPC server: emits a caller-supplied ready frame and answers each
 * command through `respond`. Lets the client mirror be checked against exact
 * wire bytes, including servers that predate a capability.
 */
function createFakeRpcServer(
	ready: Record<string, unknown>,
	respond: (command: Record<string, unknown>) => object,
): FakeRpcServer {
	const received: Record<string, unknown>[] = [];
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const exited = Promise.withResolvers<number>();
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	const stdout = new ReadableStream<Uint8Array>({
		start(streamController) {
			controller = streamController;
			streamController.enqueue(encoder.encode(`${JSON.stringify(ready)}\n`));
		},
	});
	let buffer = "";
	return {
		received,
		process: {
			stdin: {
				write(data: string | Uint8Array) {
					buffer += typeof data === "string" ? data : decoder.decode(data);
					for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
						const line = buffer.slice(0, end).trim();
						buffer = buffer.slice(end + 1);
						if (!line) continue;
						const command: Record<string, unknown> = JSON.parse(line);
						received.push(command);
						controller?.enqueue(encoder.encode(`${JSON.stringify(respond(command))}\n`));
					}
				},
			},
			stdout,
			peekStderr: () => "",
			kill: () => exited.resolve(0),
			exited: exited.promise,
		},
	};
}

/** Success envelope carrying the request's own id back. */
function ok(command: Record<string, unknown>, data?: object): object {
	return { id: command.id, type: "response", command: command.type, success: true, ...(data ? { data } : {}) };
}

/** Failure envelope carrying the request's own id back. */
function fail(command: Record<string, unknown>, error: string): object {
	return { id: command.id, type: "response", command: command.type, success: false, error };
}

describe("RPC active-turn steering (real server)", () => {
	let sessionDir: string;

	afterEach(() => {
		if (sessionDir) removeSyncWithRetries(sessionDir);
	});

	function createClient(): RpcClient {
		sessionDir = path.join(os.tmpdir(), `pi-active-turn-rpc-${Snowflake.next()}`);
		fs.mkdirSync(sessionDir, { recursive: true });
		return new RpcClient({
			cliPath: CLI_PATH,
			cwd: CLI_DIR,
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			sessionDir,
			env: { PI_NO_TITLE: "1" },
		});
	}

	test("advertises the capability and rejects an active-only steer on an idle session", async () => {
		using client = createClient();
		await client.start();

		expect(client.serverFeatures).toEqual({ activeTurnSteering: 1 });

		// No turn is running, so the host's "interrupt the current run" is refused
		// rather than turned into a new run.
		expect(await client.steer("interrupt the run", undefined, { activeTurnOnly: true })).toBe(false);

		const state = await client.getState();
		expect(state.isStreaming).toBe(false);
		expect(state.queuedMessageCount).toBe(0);
	}, 30000);

	test("acknowledges clear_queue for interrupt with the cleared counts", async () => {
		using client = createClient();
		await client.start();

		expect(await client.clearQueue({ forInterrupt: true })).toEqual({ steering: 0, followUp: 0 });
	}, 30000);
});

describe("RPC active-turn steering (client mirror)", () => {
	const READY_V1 = {
		type: "ready",
		protocolVersion: 1,
		supportedProtocolVersions: [1],
		maxFrameBytes: 1048576,
		maxReassembledFrameBytes: 33554432,
	};

	test("reads capabilities from a v1 ready frame with no protocol negotiation", async () => {
		const server = createFakeRpcServer({ ...READY_V1, features: { activeTurnSteering: 1 } }, command => ok(command));
		using client = new RpcClient({ spawn: () => server.process });
		await client.start();

		expect(client.serverFeatures).toEqual({ activeTurnSteering: 1 });
		expect(server.received).toEqual([]);
	});

	test("reads an unadvertised, bumped, or malformed capability value as absent", async () => {
		// A bumped version means changed semantics and a malformed value means a
		// broken server. Both read as absent, and neither may fail startup: a
		// client that rejects the ready frame here cannot connect to a server it
		// would otherwise interoperate with.
		for (const features of [
			{ activeTurnSteering: 2 },
			{ activeTurnSteering: true },
			{ activeTurnSteering: "1" },
			{ activeTurnSteering: { version: 1 } },
			{ activeTurnSteering: [1] },
			{ activeTurnSteering: null },
			{},
			"not-an-object",
			undefined,
		]) {
			const server = createFakeRpcServer(features === undefined ? READY_V1 : { ...READY_V1, features }, command =>
				ok(command),
			);
			using client = new RpcClient({ spawn: () => server.process });
			await client.start();
			expect(client.serverFeatures).toEqual({});
		}
	});

	test("sends activeTurnOnly only when requested and reports the server's verdict", async () => {
		const server = createFakeRpcServer({ ...READY_V1, features: { activeTurnSteering: 1 } }, command =>
			ok(command, { accepted: command.activeTurnOnly !== true }),
		);
		using client = new RpcClient({ spawn: () => server.process });
		await client.start();

		expect(await client.steer("plain steer")).toBe(true);
		expect(await client.steer("active only", undefined, { activeTurnOnly: true })).toBe(false);

		expect(server.received.map(command => command.activeTurnOnly)).toEqual([undefined, true]);
		// Request ids must round-trip; a dropped id would hang the send instead.
		expect(server.received.every(command => typeof command.id === "string")).toBe(true);
	});

	test("treats a data-less steer response from a pre-capability server as accepted", async () => {
		const server = createFakeRpcServer(READY_V1, command => ok(command));
		using client = new RpcClient({ spawn: () => server.process });
		await client.start();

		expect(await client.steer("plain steer")).toBe(true);
		expect(server.received[0]).toMatchObject({ type: "steer", message: "plain steer" });
		expect(server.received[0]).not.toHaveProperty("activeTurnOnly");
	});

	test("throws instead of reporting an enqueue when the steer command failed", async () => {
		const server = createFakeRpcServer({ ...READY_V1, features: { activeTurnSteering: 1 } }, command =>
			fail(command, "Cannot steer an extension command"),
		);
		using client = new RpcClient({ spawn: () => server.process });
		await client.start();

		// A failure is not a verdict: returning `true` here would report the
		// message as queued, and returning `false` would claim the turn had ended.
		await expect(client.steer("/ext", undefined, { activeTurnOnly: true })).rejects.toThrow(
			"Cannot steer an extension command",
		);
	});

	test("throws when a server advertising the capability omits a boolean accepted", async () => {
		const server = createFakeRpcServer({ ...READY_V1, features: { activeTurnSteering: 1 } }, command =>
			command.message === "malformed" ? ok(command, { accepted: "yes" }) : ok(command),
		);
		using client = new RpcClient({ spawn: () => server.process });
		await client.start();

		await expect(client.steer("missing")).rejects.toThrow("omitted a boolean data.accepted");
		await expect(client.steer("malformed")).rejects.toThrow("omitted a boolean data.accepted");
	});

	test("sends forInterrupt only when requested", async () => {
		const server = createFakeRpcServer({ ...READY_V1, features: { activeTurnSteering: 1 } }, command =>
			ok(command, { steering: 2, followUp: 1 }),
		);
		using client = new RpcClient({ spawn: () => server.process });
		await client.start();

		expect(await client.clearQueue()).toEqual({ steering: 2, followUp: 1 });
		expect(await client.clearQueue({ forInterrupt: true })).toEqual({ steering: 2, followUp: 1 });

		expect(server.received.map(command => command.forInterrupt)).toEqual([undefined, true]);
	});
});
