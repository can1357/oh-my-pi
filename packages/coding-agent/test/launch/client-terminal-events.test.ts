import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type IpcConnection, IpcServer } from "@oh-my-pi/pi-natives";
import type { DaemonSpec } from "@oh-my-pi/pi-tui/tools/daemon";
import {
	createDaemonBrokerClient,
	DaemonTerminalUnsupportedError,
	type DaemonBrokerClient,
	requireTerminalProtocol,
} from "../../src/launch/client";
import { daemonBrokerEndpoint } from "../../src/launch/paths";
import type {
	DaemonCompletionNotification,
	DaemonRpcResult,
	DaemonTerminalNotification,
} from "../../src/launch/protocol";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const baseSnapshot = {
	name: "mind-1",
	id: "daemon-1",
	state: "ready" as const,
	createdAt: 1,
	startedAt: 1,
	restartCount: 0,
	outputBytes: 5,
	persist: true,
	detached: false,
};

const terminalSpec: DaemonSpec = {
	name: "mind-1",
	application: "/usr/bin/node",
	args: ["-e", "process.exit(0)"],
	env: {},
	cwd: "/work",
	pty: true,
	restart: "no",
	persist: true,
	detached: false,
};

const outputFrame: DaemonTerminalNotification = {
	event: "terminal_output",
	subscriptionId: "view-1",
	name: "mind-1",
	id: "generation-1",
	sequence: 1,
	data: "\x1b[2Jhello λ\r\n",
};

const exitFrame: DaemonTerminalNotification = {
	event: "terminal_exit",
	subscriptionId: "view-1",
	name: "mind-1",
	id: "generation-1",
	exitCode: 0,
	reason: "session disposed",
};

const completionFrame: DaemonCompletionNotification = {
	event: "daemon-completed",
	completionId: "completion-1",
	owner: "session-owner",
	daemon: baseSnapshot,
};

type WireRequest = Record<string, unknown> & { id: string };

interface FakeBroker {
	runtimeDir: string;
	received: WireRequest[];
	hook: ((request: WireRequest) => void) | undefined;
	notify(message: unknown): void;
	respond(request: WireRequest, result: unknown): void;
	close(): Promise<void>;
}

function operationName(request: WireRequest): string {
	const operation = request.operation;
	if (
		typeof operation !== "object" ||
		operation === null ||
		!("op" in operation) ||
		typeof operation.op !== "string"
	) {
		throw new Error("fake broker received a request without an operation name");
	}
	return operation.op;
}

function defaultResult(request: WireRequest): unknown {
	switch (operationName(request)) {
		case "ping":
			return { projectDir: "/fake-project" };
		case "list":
			return { daemons: [] };
		default:
			return {};
	}
}

async function serveBroker(): Promise<FakeBroker> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-terminal-client-"));
	const runtimeDir = path.join(root, "runtime");
	const connections: IpcConnection[] = [];
	let peer: IpcConnection | undefined;
	const broker: FakeBroker = {
		runtimeDir,
		received: [],
		hook: undefined,
		notify(message) {
			if (!peer) throw new Error("fake broker has no connected client");
			peer.send(JSON.stringify(message));
		},
		respond(request, result) {
			this.notify({ id: request.id, ok: true, result });
		},
		async close() {
			for (const connection of connections) connection.destroy();
			await server.close();
			await fs.rm(root, { recursive: true, force: true });
		},
	};
	const server = await IpcServer.listen(daemonBrokerEndpoint(runtimeDir), { framing: "lines" }, connection => {
		peer = connection;
		connections.push(connection);
		connection.start(
			line => {
				const request = JSON.parse(line) as WireRequest;
				broker.received.push(request);
				if (broker.hook) {
					broker.hook(request);
					return;
				}
				broker.respond(request, defaultResult(request));
			},
			() => {
				if (peer === connection) peer = undefined;
			},
		);
	});
	return broker;
}

async function connect(): Promise<{ broker: FakeBroker; client: DaemonBrokerClient }> {
	const broker = await serveBroker();
	const projectDir = path.join(broker.runtimeDir, "..", "project");
	await fs.mkdir(projectDir, { recursive: true });
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir: broker.runtimeDir, idleGraceMs: 1_000 });
	cleanups.push(async () => {
		client.close();
		await broker.close();
	});
	return { broker, client };
}

describe("existing broker connections", () => {
	it("refuses a missing token without creating runtime files or starting a broker", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-existing-broker-"));
		cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
		const projectDir = path.join(root, "project");
		await fs.mkdir(projectDir);
		const before = await fs.readdir(root, { recursive: true });
		await expect(
			createDaemonBrokerClient(projectDir, { runtimeDir: path.join(root, "runtime"), existingOnly: true }),
		).rejects.toThrow();
		expect(await fs.readdir(root, { recursive: true })).toEqual(before);
	});
});

describe("terminal event routing", () => {
	it("routes terminal output and exit to their subscription sink", async () => {
		const { broker, client } = await connect();
		const frames: DaemonTerminalNotification[] = [];
		const delivered = Promise.withResolvers<void>();
		const off = client.subscribeTerminal("view-1", frame => {
			frames.push(frame);
			if (frames.length === 2) delivered.resolve();
		});
		await client.request({ op: "ping" });

		broker.notify(outputFrame);
		broker.notify(exitFrame);
		await delivered.promise;

		expect(frames).toEqual([outputFrame, exitFrame]);
		expect(frames.map(frame => frame.event)).toEqual(["terminal_output", "terminal_exit"]);
		off();
	});

	it("never delivers a terminal frame to an unrelated subscription", async () => {
		const { broker, client } = await connect();
		const first: DaemonTerminalNotification[] = [];
		const second: DaemonTerminalNotification[] = [];
		client.subscribeTerminal("view-1", frame => first.push(frame));
		client.subscribeTerminal("view-2", frame => second.push(frame));
		await client.request({ op: "ping" });

		broker.notify({ ...outputFrame, subscriptionId: "view-2" });
		broker.notify({ ...outputFrame, subscriptionId: "view-9", sequence: 2 });
		await client.request({ op: "ping" });

		expect(first).toEqual([]);
		expect(second).toEqual([{ ...outputFrame, subscriptionId: "view-2" }]);
	});

	it("keeps completion notifications out of terminal sinks and vice versa", async () => {
		const { broker, client } = await connect();
		const terminal: DaemonTerminalNotification[] = [];
		const completions: DaemonCompletionNotification[] = [];
		const delivered = Promise.withResolvers<void>();
		const settle = (): void => {
			if (terminal.length === 1 && completions.length === 1) delivered.resolve();
		};
		let announced = false;
		broker.hook = request => {
			broker.respond(request, defaultResult(request));
			if (announced || operationName(request) !== "ping") return;
			announced = true;
			broker.notify(completionFrame);
			broker.notify(outputFrame);
		};
		client.subscribeTerminal("view-1", frame => {
			terminal.push(frame);
			settle();
		});
		client.onCompletion("session-owner", notification => {
			completions.push(notification);
			settle();
		});

		await delivered.promise;

		expect(completions).toEqual([completionFrame]);
		expect(terminal).toEqual([outputFrame]);
	});

	it("delivers output the broker sends before the start response", async () => {
		const { broker, client } = await connect();
		const frames: DaemonTerminalNotification[] = [];
		client.subscribeTerminal("view-1", frame => frames.push(frame));
		broker.hook = request => {
			if (operationName(request) !== "terminal_start") {
				broker.respond(request, defaultResult(request));
				return;
			}
			broker.notify(outputFrame);
			broker.respond(request, { daemon: baseSnapshot });
		};

		const result = await client.request({
			op: "terminal_start",
			subscriptionId: "view-1",
			spec: terminalSpec,
			columns: 93,
			rows: 31,
		});

		expect(result).toEqual({ op: "terminal_start", daemon: baseSnapshot });
		expect(frames).toEqual([outputFrame]);
	});

	it("does not settle an unrelated request when a terminal frame is malformed", async () => {
		const { broker, client } = await connect();
		const frames: DaemonTerminalNotification[] = [];
		client.subscribeTerminal("view-1", frame => frames.push(frame));
		broker.hook = request => {
			broker.notify({ ...outputFrame, data: 7 });
			broker.respond(request, defaultResult(request));
		};

		expect(await client.request({ op: "ping" })).toEqual({ op: "ping", projectDir: "/fake-project" });
		expect(frames).toEqual([]);
	});

	it("drops a terminal sink without sending a detach frame", async () => {
		const { broker, client } = await connect();
		const frames: DaemonTerminalNotification[] = [];
		const off = client.subscribeTerminal("view-1", frame => frames.push(frame));
		off();

		await client.request({ op: "ping" });
		broker.notify(outputFrame);
		await client.request({ op: "ping" });

		expect(frames).toEqual([]);
		expect(broker.received.map(operationName)).toEqual(["ping", "ping"]);
	});

	it("keeps the legacy request envelope unchanged", async () => {
		const { broker, client } = await connect();
		await client.request({ op: "list" });

		const [request] = broker.received;
		expect(Object.keys(request)).toEqual([
			"id",
			"token",
			"owners",
			"detachedOwners",
			"completionEvents",
			"completionUnsubscribes",
			"completionReplays",
			"completionSubscriptionId",
			"operation",
		]);
		expect(request.operation).toEqual({ op: "list" });
		expect(request.owners).toEqual([]);
		expect(request.detachedOwners).toEqual([]);
		expect(request.completionUnsubscribes).toEqual([]);
		expect(request.completionReplays).toEqual([]);
		expect(request.completionEvents).toBe(true);
		expect(typeof request.completionSubscriptionId).toBe("string");
	});
});

describe("terminal capability", () => {
	function stubClient(ping: DaemonRpcResult): DaemonBrokerClient {
		return {
			projectDir: "/work/project",
			onCompletion: () => () => {},
			subscribeTerminal: () => () => {},
			request: async operation => {
				if (operation.op !== "ping") throw new Error(`unexpected broker op ${operation.op}`);
				return ping;
			},
			close: () => {},
		};
	}

	it("refuses a broker that does not advertise terminal streams", async () => {
		const error = await requireTerminalProtocol(stubClient({ op: "ping", projectDir: "/work/project" })).then(
			() => undefined,
			(rejection: unknown) => rejection,
		);
		if (!(error instanceof DaemonTerminalUnsupportedError)) throw new Error("expected a terminal capability error");
		expect(error.message).toContain("/work/project");
	});

	it("accepts a broker that advertises version 1", async () => {
		await requireTerminalProtocol(
			stubClient({ op: "ping", projectDir: "/work/project", terminalProtocolVersion: 1 }),
		);
	});
});
