import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { DapClient } from "@oh-my-pi/pi-coding-agent/dap/client";
import { DapSessionManager } from "@oh-my-pi/pi-coding-agent/dap/session";
import type {
	DapCapabilities,
	DapClientState,
	DapEventMessage,
	DapResolvedAdapter,
	DapThread,
} from "@oh-my-pi/pi-coding-agent/dap/types";
import { type ChildProcess, ptree } from "@oh-my-pi/pi-utils";

const TEST_ADAPTER: DapResolvedAdapter = {
	name: "js-debug-adapter",
	command: "node",
	args: ["dapDebugServer.js", "$" + "{port}", "127.0.0.1"],
	resolvedCommand: "node",
	languages: ["javascript", "typescript"],
	fileTypes: [".js", ".ts"],
	rootMarkers: ["package.json"],
	launchDefaults: { request: "launch", type: "pwa-node", stopOnEntry: true },
	attachDefaults: { request: "attach", type: "pwa-node" },
	connectMode: "tcp",
	acceptsDirectoryProgram: false,
};

type EventHandler = (body: unknown, event: DapEventMessage) => void | Promise<void>;
type ReverseHandler = (args: unknown) => unknown | Promise<unknown>;

interface FakeOptions {
	/** Threads returned by this session's `threads` request. */
	threads?: DapThread[];
	/** Thread id reported by the synthetic `stopped` event (defaults to 7). */
	stopThreadId?: number;
}

class FakeDapClient {
	readonly proc: DapClientState["proc"];
	readonly port = 8123;
	readonly requests: Array<{ command: string; args: unknown }> = [];
	readonly #events = new Map<string, Set<EventHandler>>();
	readonly #reverseHandlers = new Map<string, ReverseHandler>();
	readonly #exited = Promise.withResolvers<void>();
	#alive = true;
	disposed = false;

	constructor(
		readonly childConfiguration?: Record<string, unknown>,
		readonly childRequest: "launch" | "attach" = "launch",
		readonly stopOnStart = true,
		readonly options: FakeOptions = {},
	) {
		this.proc = {
			exited: this.#exited.promise,
			exitCode: null,
			stdin: { write: () => 0, flush: () => undefined },
			stdout: new ReadableStream<Uint8Array>(),
			stderr: new ReadableStream<Uint8Array>(),
			peekStderr: () => "",
			kill: () => {
				this.#alive = false;
				this.#exited.resolve();
				return true;
			},
		} as unknown as DapClientState["proc"];
	}

	async initialize(): Promise<DapCapabilities> {
		queueMicrotask(() => this.#emit("initialized", {}));
		return { supportsConfigurationDoneRequest: true };
	}

	async sendRequest(command: string, args?: unknown): Promise<unknown> {
		this.requests.push({ command, args });
		if (command === "launch") {
			if (this.childConfiguration) {
				queueMicrotask(() => {
					void this.#emitReverse("startDebugging", {
						request: this.childRequest,
						configuration: this.childConfiguration,
					});
				});
			} else if (this.stopOnStart) {
				queueMicrotask(() => this.#emit("stopped", { reason: "entry", threadId: this.options.stopThreadId ?? 7 }));
			}
		}
		if (command === "threads") return { threads: this.options.threads ?? [{ id: 7, name: "target.js" }] };
		if (command === "stackTrace") {
			return {
				stackFrames: [{ id: 70, name: "main", line: 2, column: 1, source: { path: "/tmp/target.js" } }],
			};
		}
		if (command.endsWith("Breakpoints")) {
			const breakpointArgs = args as { breakpoints?: unknown[] } | undefined;
			return { breakpoints: (breakpointArgs?.breakpoints ?? []).map((_, id) => ({ id, verified: true })) };
		}
		return {};
	}

	waitForEvent(event: string): Promise<unknown> {
		const { promise, resolve } = Promise.withResolvers<unknown>();
		const unsubscribe = this.onEvent(event, body => {
			unsubscribe();
			resolve(body);
		});
		return promise;
	}

	onEvent(event: string, handler: EventHandler): () => void {
		const handlers = this.#events.get(event) ?? new Set<EventHandler>();
		handlers.add(handler);
		this.#events.set(event, handlers);
		return () => handlers.delete(handler);
	}

	onReverseRequest(command: string, handler: ReverseHandler): () => void {
		this.#reverseHandlers.set(command, handler);
		return () => this.#reverseHandlers.delete(command);
	}

	isAlive(): boolean {
		return this.#alive;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.#alive = false;
		this.#exited.resolve();
	}

	#emit(event: string, body: unknown): void {
		const message: DapEventMessage = { seq: 1, type: "event", event, body };
		for (const handler of this.#events.get(event) ?? []) void handler(body, message);
	}

	emit(event: string, body: unknown): void {
		this.#emit(event, body);
	}

	/** Drive an adapter-initiated reverse request (e.g. a late `startDebugging`). */
	async triggerReverse(command: string, args: unknown): Promise<void> {
		await this.#emitReverse(command, args);
	}

	async #emitReverse(command: string, args: unknown): Promise<void> {
		const handler = this.#reverseHandlers.get(command);
		if (!handler) throw new Error(`Missing reverse handler for ${command}`);
		await handler(args);
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("DAP multi-session debugging", () => {
	it("routes recursive js-debug children, breakpoints, and termination through one session tree", async () => {
		const root = new FakeDapClient({
			name: "target.js",
			type: "pwa-node",
			__pendingTargetId: "child",
			program: "/tmp/target.js",
		});
		const child = new FakeDapClient({
			name: "[worker 1]",
			type: "pwa-node",
			__pendingTargetId: "grandchild",
		});
		const grandchild = new FakeDapClient();
		const children = [child, grandchild];
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		spyOn(DapClient, "connect").mockImplementation(async () => {
			const next = children.shift();
			if (!next) throw new Error("Unexpected child DAP connection");
			return next as unknown as DapClient;
		});
		const manager = new DapSessionManager();

		const launched = await manager.launch(
			{ adapter: TEST_ADAPTER, program: "/tmp/target.js", cwd: "/tmp" },
			undefined,
			1_000,
		);

		expect(launched.status).toBe("stopped");
		expect(launched.parentSessionId).toBeDefined();
		expect(launched.line).toBe(2);
		expect(manager.listSessions()).toHaveLength(3);

		const breakpoint = await manager.setBreakpoint("/tmp/target.js", 2, undefined, undefined, 1_000);
		expect(breakpoint.breakpoints).toEqual([
			{ line: 2, condition: undefined, id: 0, verified: true, message: undefined },
		]);
		for (const client of [root, child, grandchild]) {
			expect(client.requests.filter(request => request.command === "setBreakpoints")).toHaveLength(1);
		}

		await manager.terminate(undefined, 1_000);
		expect(manager.listSessions()).toEqual([]);
		for (const client of [root, child, grandchild]) {
			expect(client.requests.some(request => request.command === "disconnect")).toBe(true);
			expect(client.disposed).toBe(true);
		}
	});

	it("targets a running attach child before it emits a stopped event", async () => {
		const root = new FakeDapClient(
			{
				name: "attached.js",
				type: "pwa-node",
				__pendingTargetId: "attached-child",
			},
			"attach",
			true,
			// Threadless launcher: answers `threads` with an empty list.
			{ threads: [] },
		);
		const child = new FakeDapClient(undefined, "launch", false);
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		spyOn(DapClient, "connect").mockResolvedValue(child as unknown as DapClient);
		const manager = new DapSessionManager();

		await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/attached.js", cwd: "/tmp" }, undefined, 25);
		const active = manager.getActiveSession();
		const threads = await manager.threads(undefined, 100);

		expect(active?.parentSessionId).toBeDefined();
		expect(threads.threads).toEqual([{ id: 7, name: "target.js" }]);
		expect(child.requests.filter(request => request.command === "threads")).toHaveLength(1);
		// The root is queried too (no topology guess), but being threadless it
		// contributes nothing.
		expect(root.requests.filter(request => request.command === "threads")).toHaveLength(1);

		await manager.terminate(undefined, 100);
	});

	it("reactivates a live session when the active child terminates", async () => {
		const root = new FakeDapClient({
			name: "target.js",
			type: "pwa-node",
			__pendingTargetId: "child",
		});
		const child = new FakeDapClient();
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		spyOn(DapClient, "connect").mockResolvedValue(child as unknown as DapClient);
		const manager = new DapSessionManager();

		const launched = await manager.launch(
			{ adapter: TEST_ADAPTER, program: "/tmp/target.js", cwd: "/tmp" },
			undefined,
			1_000,
		);
		expect(launched.parentSessionId).toBeDefined();

		child.emit("terminated", {});
		await child.dispose();

		const active = manager.getActiveSession();
		expect(active).not.toBeNull();
		expect(active?.id).not.toBe(launched.id);
		expect(active?.status).not.toBe("terminated");

		const threads = await manager.threads(undefined, 100);
		expect(threads.threads).toEqual([{ id: 7, name: "target.js" }]);
		expect(root.requests.filter(request => request.command === "threads")).toHaveLength(1);

		await manager.terminate(undefined, 100);
	});

	it("keeps focus on the stopped script child when a worker attaches later", async () => {
		const root = new FakeDapClient(
			{
				name: "script.mts",
				type: "pwa-node",
				__pendingTargetId: "main",
				program: "/tmp/script.mts",
			},
			"launch",
			true,
			// Threadless launcher: it answers `threads` with an empty list.
			{ threads: [] },
		);
		// The script child stops on entry (thread 1), then a worker session
		// attaches afterwards via a late reverse `startDebugging`.
		const main = new FakeDapClient(undefined, "launch", true, {
			threads: [{ id: 1, name: "script.mts" }],
			stopThreadId: 1,
		});
		const worker = new FakeDapClient(undefined, "launch", false, {
			threads: [{ id: 1, name: "[worker 1]" }],
		});
		const children = [main, worker];
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		spyOn(DapClient, "connect").mockImplementation(async () => {
			const next = children.shift();
			if (!next) throw new Error("Unexpected child DAP connection");
			return next as unknown as DapClient;
		});
		const manager = new DapSessionManager();

		const launched = await manager.launch(
			{ adapter: TEST_ADAPTER, program: "/tmp/script.mts", cwd: "/tmp" },
			undefined,
			1_000,
		);
		expect(launched.status).toBe("stopped");
		const scriptSessionId = launched.id;

		// A worker_threads spawn triggers a late child attach on the launcher.
		await root.triggerReverse("startDebugging", {
			request: "launch",
			configuration: { name: "[worker 1]", type: "pwa-node" },
		});
		expect(manager.listSessions()).toHaveLength(3);

		// Focus must stay on the stopped script child, not jump to the worker.
		const active = manager.getActiveSession();
		expect(active?.id).toBe(scriptSessionId);
		expect(active?.threadId).toBe(1);

		// `threads` must surface every live thread across the tree, not just one.
		const threads = await manager.threads(undefined, 1_000);
		expect(threads.threads).toHaveLength(2);
		expect(threads.threads).toEqual(
			expect.arrayContaining([
				{ id: 1, name: "script.mts" },
				{ id: 1, name: "[worker 1]" },
			]),
		);
		// The launcher is still queried, but being threadless it contributes none.
		expect(root.requests.filter(request => request.command === "threads")).toHaveLength(1);

		await manager.terminate(undefined, 1_000);
	});

	it("preserves per-session threads that share an id and name across children", async () => {
		const root = new FakeDapClient(
			{ name: "pool.mjs", type: "pwa-node", __pendingTargetId: "main", program: "/tmp/pool.mjs" },
			"launch",
			true,
			{ threads: [] },
		);
		// Two identical worker scripts each expose the same session-local thread
		// id and name; DAP scopes ids per session, so both are distinct threads.
		const main = new FakeDapClient(undefined, "launch", true, {
			threads: [{ id: 1, name: "worker.js" }],
			stopThreadId: 1,
		});
		const worker = new FakeDapClient(undefined, "launch", false, {
			threads: [{ id: 1, name: "worker.js" }],
		});
		const children = [main, worker];
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		spyOn(DapClient, "connect").mockImplementation(async () => {
			const next = children.shift();
			if (!next) throw new Error("Unexpected child DAP connection");
			return next as unknown as DapClient;
		});
		const manager = new DapSessionManager();

		await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/pool.mjs", cwd: "/tmp" }, undefined, 1_000);
		await root.triggerReverse("startDebugging", {
			request: "launch",
			configuration: { name: "worker #2", type: "pwa-node" },
		});
		expect(manager.listSessions()).toHaveLength(3);

		const threads = await manager.threads(undefined, 1_000);
		// Both identical threads survive aggregation \u2014 not collapsed into one.
		expect(threads.threads).toEqual([
			{ id: 1, name: "worker.js" },
			{ id: 1, name: "worker.js" },
		]);

		await manager.terminate(undefined, 1_000);
	});

	it("drains a runInTerminal debuggee's stdout into the session output buffer", async () => {
		const root = new FakeDapClient(undefined, "launch", true);
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);

		// Synthetic debuggee stdout: >64KB ahead of a unique terminal marker,
		// then a trailing sentinel and EOF. The handler discards the ptree child
		// after reading its PID, so the drain must consume this whole stream and
		// route it to the session output — undrained, the marker never reaches
		// the buffer. The sentinel after the marker guarantees the marker chunk
		// is routed (in the read cycle before it) before `closed` resolves.
		const marker = "__RUNINTERMINAL_MARKER__";
		const enc = new TextEncoder();
		const chunks = [enc.encode("x".repeat(128 * 1024)), enc.encode(`${marker}\n`), enc.encode("tail\n")];
		let next = 0;
		const closed = Promise.withResolvers<void>();
		const stdout = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (next < chunks.length) {
					controller.enqueue(chunks[next++]);
				} else {
					controller.close();
					closed.resolve();
				}
			},
		});
		const spawnSpy = spyOn(ptree, "spawn").mockReturnValue({ pid: 4242, stdout } as unknown as ChildProcess);

		const manager = new DapSessionManager();
		await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/target.js", cwd: "/tmp" }, undefined, 1_000);

		await root.triggerReverse("runInTerminal", { args: ["/usr/bin/debuggee", "--verbose"] });
		// The stream reaching EOF proves the drain consumed it end to end; the
		// marker (routed before close) is then present in the session output.
		await closed.promise;

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		expect(spawnSpy.mock.calls[0]?.[0]).toEqual(["/usr/bin/debuggee", "--verbose"]);
		const output = manager.getOutput();
		expect(output.output).toContain(marker);
		expect(output.snapshot.outputBytes).toBeGreaterThan(128 * 1024);
		expect(output.snapshot.outputTruncated).toBe(true);
		expect(Buffer.byteLength(output.output, "utf-8")).toBeLessThanOrEqual(128 * 1024);

		await manager.terminate(undefined, 1_000);
	});
});
