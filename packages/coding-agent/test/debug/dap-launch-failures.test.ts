import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import * as dapModule from "@pk-nerdsaver-ai/pi-coding-agent/dap";
import { DapClient } from "@pk-nerdsaver-ai/pi-coding-agent/dap/client";
import { DapSessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/dap/session";
import type {
	DapCapabilities,
	DapClientState,
	DapEventMessage,
	DapResolvedAdapter,
} from "@pk-nerdsaver-ai/pi-coding-agent/dap/types";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { DebugTool } from "@pk-nerdsaver-ai/pi-coding-agent/tools/debug";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

const TEST_ADAPTER: DapResolvedAdapter = {
	name: "lldb-dap",
	command: "lldb-dap",
	args: [],
	resolvedCommand: "lldb-dap",
	languages: [],
	fileTypes: [],
	rootMarkers: [],
	launchDefaults: {},
	attachDefaults: {},
	connectMode: "stdio",
	acceptsDirectoryProgram: false,
};

const DELAYED_UNIX_SOCKET_ADAPTER = `
const listenPrefix = "--listen=unix:";
const listenArg = process.argv.find(arg => arg.startsWith(listenPrefix));
if (!listenArg) {
	throw new Error("missing --listen=unix argument");
}
const socketPath = listenArg.slice(listenPrefix.length);
let server;
process.on("SIGTERM", () => {
	server?.stop();
	process.exit(0);
});
await Bun.sleep(100);
server = Bun.listen({
	unix: socketPath,
	socket: {
		open() {},
		data() {},
		close() {},
		error() {},
	},
});
await Bun.sleep(2_000);
server.stop();
`;

type DapEventHandler = (body: unknown, event: DapEventMessage) => void | Promise<void>;

class FakeDapClient {
	readonly proc: DapClientState["proc"];
	readonly #exited = Promise.withResolvers<void>();
	readonly #handlers = new Map<string, Set<DapEventHandler>>();
	#alive = true;
	requests: Array<{ command: string; args: unknown }> = [];

	constructor(
		readonly adapter: DapResolvedAdapter,
		readonly cwd: string,
		readonly options: {
			launchError?: string;
			launchErrorDelayMs?: number;
			attachError?: string;
			attachErrorDelayMs?: number;
			configurationDoneError?: string;
			rejectStopWaiters?: boolean;
			stopAfterLaunch?: boolean;
		},
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
		if (command === "launch" && this.options.launchError) {
			if (this.options.launchErrorDelayMs) await Bun.sleep(this.options.launchErrorDelayMs);
			throw new Error(this.options.launchError);
		}
		if (command === "attach" && this.options.attachError) {
			if (this.options.attachErrorDelayMs) await Bun.sleep(this.options.attachErrorDelayMs);
			throw new Error(this.options.attachError);
		}
		if (command === "configurationDone" && this.options.configurationDoneError) {
			throw new Error(this.options.configurationDoneError);
		}
		if (command === "launch" && this.options.stopAfterLaunch) {
			queueMicrotask(() => this.#emit("stopped", { reason: "entry", threadId: 1 }));
		}
		return {};
	}

	waitForEvent(event: string): Promise<unknown> {
		if (this.options.rejectStopWaiters && (event === "stopped" || event === "terminated" || event === "exited")) {
			return Promise.reject(new Error(`DAP event ${event} timed out after 1ms`));
		}
		const { promise, resolve } = Promise.withResolvers<unknown>();
		const unsubscribe = this.onEvent(event, body => {
			unsubscribe();
			resolve(body);
		});
		return promise;
	}

	onEvent(event: string, handler: DapEventHandler): () => void {
		let handlers = this.#handlers.get(event);
		if (!handlers) {
			handlers = new Set<DapEventHandler>();
			this.#handlers.set(event, handlers);
		}
		handlers.add(handler);
		return () => handlers?.delete(handler);
	}

	onReverseRequest(): () => void {
		return () => {};
	}

	isAlive(): boolean {
		return this.#alive;
	}

	async dispose(): Promise<void> {
		this.#alive = false;
		this.#exited.resolve();
	}

	#emit(event: string, body: unknown): void {
		const message: DapEventMessage = { seq: 1, type: "event", event, body };
		for (const handler of this.#handlers.get(event) ?? []) {
			void handler(body, message);
		}
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("DAP launch failure handling", () => {
	it("preserves adapter launchDefaults args when launch omits args", async () => {
		const adapter: DapResolvedAdapter = {
			...TEST_ADAPTER,
			launchDefaults: { request: "launch", args: ["--configured"], stopOnEntry: true },
		};
		const manager = new DapSessionManager();
		const fake = new FakeDapClient(adapter, process.cwd(), { stopAfterLaunch: true });
		spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

		await manager.launch({ adapter, program: "/bin/echo", cwd: process.cwd() }, undefined, 10);

		const launch = fake.requests.find(request => request.command === "launch");
		expect(launch?.args).toMatchObject({ args: ["--configured"], program: "/bin/echo" });
	});

	it("surfaces the launch failure when configurationDone also fails", async () => {
		const manager = new DapSessionManager();
		const fake = new FakeDapClient(TEST_ADAPTER, process.cwd(), {
			launchError: "launch: 'C:\\repo\\python' is not a valid executable",
			configurationDoneError: "configurationDone: Expected process to be stopped.",
		});
		spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

		let message = "";
		try {
			await manager.launch({ adapter: TEST_ADAPTER, program: "C:\\repo\\python", cwd: process.cwd() });
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			message = (error as Error).message;
		}

		expect(message).toContain("launch: 'C:\\repo\\python' is not a valid executable");
		expect(message).toContain("configurationDone: Expected process to be stopped.");
	});

	it("surfaces the attach failure when configurationDone also fails", async () => {
		const manager = new DapSessionManager();
		const fake = new FakeDapClient(TEST_ADAPTER, process.cwd(), {
			attachError: "attach: target process exited",
			configurationDoneError: "configurationDone: Expected process to be stopped.",
		});
		spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

		let message = "";
		try {
			await manager.attach({ adapter: TEST_ADAPTER, cwd: process.cwd(), pid: 123 });
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			message = (error as Error).message;
		}

		expect(message).toContain("attach: target process exited");
		expect(message).toContain("configurationDone: Expected process to be stopped.");
	});

	it("does not emit an unhandled rejection when launch fails before initial stop watchers settle", async () => {
		const manager = new DapSessionManager();
		const fake = new FakeDapClient(TEST_ADAPTER, process.cwd(), {
			launchError: "launch: failed before stop outcome",
			rejectStopWaiters: true,
		});
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

		try {
			await expect(
				manager.launch({ adapter: TEST_ADAPTER, program: "/bin/echo", cwd: process.cwd() }),
			).rejects.toThrow("launch: failed before stop outcome");
			await Bun.sleep(10);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("surfaces the adapter name and ENOENT when spawn fails", async () => {
		const manager = new DapSessionManager();
		spyOn(DapClient, "spawn").mockRejectedValue(new Error("ENOENT: no such file or directory, spawn 'lldb-dap'"));

		let message = "";
		try {
			await manager.launch({ adapter: TEST_ADAPTER, program: "/bin/echo", cwd: process.cwd() });
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			message = (error as Error).message;
		}

		expect(message).toContain("ENOENT");
		expect(message).toContain(TEST_ADAPTER.name);
	});

	it("surfaces 'pip install debugpy' when launch stderr mentions missing module", async () => {
		const manager = new DapSessionManager();
		const debugpyAdapter: DapResolvedAdapter = { ...TEST_ADAPTER, name: "debugpy" };
		const fake = new FakeDapClient(debugpyAdapter, process.cwd(), {
			launchError: "ImportError: No module named 'debugpy'",
		});
		spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

		let message = "";
		try {
			await manager.launch({ adapter: debugpyAdapter, program: "/bin/echo", cwd: process.cwd() });
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			message = (error as Error).message;
		}

		expect(message).toContain("pip install debugpy");
		expect(message).toContain("debugpy");
	});

	it("surfaces 'pip install debugpy' when attach stderr mentions missing module", async () => {
		const manager = new DapSessionManager();
		const debugpyAdapter: DapResolvedAdapter = { ...TEST_ADAPTER, name: "debugpy" };
		const fake = new FakeDapClient(debugpyAdapter, process.cwd(), {
			attachError: 'ModuleNotFoundError: No module named "debugpy"',
		});
		spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

		let message = "";
		try {
			await manager.attach({ adapter: debugpyAdapter, cwd: process.cwd(), pid: 123 });
		} catch (error) {
			message = (error as Error).message;
		}

		expect(message).toContain("pip install debugpy");
	});

	it("does NOT rewrite to 'pip install debugpy' for non-debugpy adapters even when stderr mentions the module", async () => {
		const manager = new DapSessionManager();
		const fake = new FakeDapClient(TEST_ADAPTER, process.cwd(), {
			launchError: "incidental log line: No module named debugpy was here but the adapter is lldb-dap",
		});
		spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

		let message = "";
		try {
			await manager.launch({ adapter: TEST_ADAPTER, program: "/bin/echo", cwd: process.cwd() });
		} catch (error) {
			message = (error as Error).message;
		}

		expect(message).not.toContain("pip install debugpy");
		expect(message).toContain("incidental log line");
	});

	it("prefers a delayed launch failure over the configurationDone cascade", async () => {
		// Models real adapter I/O where the launch failure arrives via socket
		// several ticks after configurationDone has already rejected. The old
		// `await Promise.resolve()` (one microtask) would miss the late launch
		// rejection and surface only the configurationDone cascade.
		const manager = new DapSessionManager();
		const fake = new FakeDapClient(TEST_ADAPTER, process.cwd(), {
			launchError: "launch: 'C:\\repo\\program' is not a valid executable",
			launchErrorDelayMs: 10,
			configurationDoneError: "configurationDone: Expected process to be stopped.",
		});
		spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

		let message = "";
		try {
			await manager.launch({ adapter: TEST_ADAPTER, program: "C:\\repo\\program", cwd: process.cwd() });
		} catch (error) {
			message = (error as Error).message;
		}

		// The combined error must include the launch failure as the preferred
		// error — not just the configurationDone cascade. Both messages are
		// present in the combined form (see combineDapStartErrors), but the
		// regression-prone case is omitting the launch line entirely.
		expect(message).toContain("launch: 'C:\\repo\\program' is not a valid executable");
		expect(message).toContain("configurationDone: Expected process to be stopped.");
	});

	it("waits for delayed Unix socket adapters before connecting on Linux", async () => {
		if (process.platform !== "linux") return;
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-debug-dlv-socket-"));
		const adapterPath = path.join(cwd, "delayed-unix-socket-adapter.mjs");
		await fs.writeFile(adapterPath, DELAYED_UNIX_SOCKET_ADAPTER);
		const adapter: DapResolvedAdapter = {
			...TEST_ADAPTER,
			name: "dlv",
			command: process.execPath,
			args: [adapterPath],
			resolvedCommand: process.execPath,
			connectMode: "socket",
		};
		let client: DapClient | undefined;
		try {
			client = await DapClient.spawn({ adapter, cwd });
			expect(client.isAlive()).toBe(true);
		} finally {
			await client?.dispose();
			await removeWithRetries(cwd);
		}
	});
});

describe("DebugTool launch validation", () => {
	it("rejects directory programs when the selected adapter cannot debug a directory", async () => {
		const launchSpy = spyOn(dapModule, "selectLaunchAdapter").mockReturnValue(TEST_ADAPTER);
		try {
			const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-debug-program-"));
			try {
				await fs.mkdir(path.join(cwd, "python"));
				const session: ToolSession = {
					cwd,
					hasUI: false,
					getSessionFile: () => null,
					getSessionSpawns: () => "*",
					settings: Settings.isolated({ "debug.enabled": true }),
				};
				const tool = new DebugTool(session);

				await expect(tool.execute("call", { action: "launch", program: "python" })).rejects.toThrow(
					/launch program resolves to a directory.*python/,
				);
			} finally {
				await removeWithRetries(cwd);
			}
		} finally {
			launchSpy.mockRestore();
		}
	});

	it("allows directory programs when the selected adapter accepts them (dlv on a Go package)", async () => {
		const dlvAdapter: DapResolvedAdapter = {
			...TEST_ADAPTER,
			name: "dlv",
			command: "dlv",
			resolvedCommand: "dlv",
			launchDefaults: { request: "launch", mode: "debug", stopOnEntry: true },
			acceptsDirectoryProgram: true,
		};
		const launchSpy = spyOn(dapModule, "selectLaunchAdapter").mockReturnValue(dlvAdapter);
		const sessionLaunchSpy = spyOn(dapModule.dapSessionManager, "launch").mockImplementation(async opts => {
			throw Object.assign(new Error("captured launch"), { capturedOptions: opts });
		});
		try {
			const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-debug-dlv-dir-"));
			try {
				await fs.mkdir(path.join(cwd, "cmd"));
				const session: ToolSession = {
					cwd,
					hasUI: false,
					getSessionFile: () => null,
					getSessionSpawns: () => "*",
					settings: Settings.isolated({ "debug.enabled": true }),
				};
				const tool = new DebugTool(session);

				// Validation must pass and propagate to dapSessionManager.launch; we
				// stop the actual spawn there and inspect the launch arguments.
				await expect(tool.execute("call", { action: "launch", program: "cmd", adapter: "dlv" })).rejects.toThrow(
					/captured launch/,
				);
				expect(sessionLaunchSpy).toHaveBeenCalledTimes(1);
				const [opts] = sessionLaunchSpy.mock.calls[0]!;
				expect(opts.extraLaunchArguments).toEqual({ mode: "debug" });
				expect(opts.program).toBe(path.join(cwd, "cmd"));
			} finally {
				await removeWithRetries(cwd);
			}
		} finally {
			sessionLaunchSpy.mockRestore();
			launchSpy.mockRestore();
		}
	});

	it("prefers directory-capable dlv over native adapters for extensionless Go package directories", async () => {
		const sessionLaunchSpy = spyOn(dapModule.dapSessionManager, "launch").mockImplementation(async opts => {
			throw Object.assign(new Error("captured launch"), { capturedOptions: opts });
		});
		try {
			const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-debug-dlv-mixed-roots-"));
			try {
				await fs.writeFile(path.join(cwd, "go.mod"), "module hello\n\ngo 1.22\n");
				await fs.writeFile(path.join(cwd, "Makefile"), "all:\n\tgo build ./...\n");
				await fs.mkdir(path.join(cwd, "bin"));
				await fs.writeFile(path.join(cwd, "bin", "dlv"), "");
				await fs.writeFile(path.join(cwd, "bin", "gdb"), "");
				await fs.mkdir(path.join(cwd, "cmd", "hello"), { recursive: true });
				const session: ToolSession = {
					cwd,
					hasUI: false,
					getSessionFile: () => null,
					getSessionSpawns: () => "*",
					settings: Settings.isolated({ "debug.enabled": true }),
				};
				const tool = new DebugTool(session);

				await expect(tool.execute("call", { action: "launch", program: "cmd/hello" })).rejects.toThrow(
					/captured launch/,
				);
				const [opts] = sessionLaunchSpy.mock.calls[0]!;
				expect(opts.adapter.name).toBe("dlv");
				expect(opts.extraLaunchArguments).toEqual({ mode: "debug" });
			} finally {
				await removeWithRetries(cwd);
			}
		} finally {
			sessionLaunchSpy.mockRestore();
		}
	});

	it("dlv launch with a compiled binary switches mode from debug to exec", async () => {
		const dlvAdapter: DapResolvedAdapter = {
			...TEST_ADAPTER,
			name: "dlv",
			command: "dlv",
			resolvedCommand: "dlv",
			launchDefaults: { request: "launch", mode: "debug", stopOnEntry: true },
			acceptsDirectoryProgram: true,
		};
		const launchSpy = spyOn(dapModule, "selectLaunchAdapter").mockReturnValue(dlvAdapter);
		const sessionLaunchSpy = spyOn(dapModule.dapSessionManager, "launch").mockImplementation(async opts => {
			throw Object.assign(new Error("captured launch"), { capturedOptions: opts });
		});
		try {
			const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-debug-dlv-exec-"));
			try {
				await fs.writeFile(path.join(cwd, "hello"), "#!/usr/bin/env sh\necho hi\n");
				const session: ToolSession = {
					cwd,
					hasUI: false,
					getSessionFile: () => null,
					getSessionSpawns: () => "*",
					settings: Settings.isolated({ "debug.enabled": true }),
				};
				const tool = new DebugTool(session);

				await expect(tool.execute("call", { action: "launch", program: "hello", adapter: "dlv" })).rejects.toThrow(
					/captured launch/,
				);
				const [opts] = sessionLaunchSpy.mock.calls[0]!;
				expect(opts.extraLaunchArguments).toEqual({ mode: "exec" });
			} finally {
				await removeWithRetries(cwd);
			}
		} finally {
			sessionLaunchSpy.mockRestore();
			launchSpy.mockRestore();
		}
	});

	it("throws targeted 'python not found in PATH' when adapter:'debugpy' is unresolvable for launch", async () => {
		const launchSpy = spyOn(dapModule, "selectLaunchAdapter").mockReturnValue(null);
		try {
			const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-debug-debugpy-"));
			try {
				await fs.writeFile(path.join(cwd, "main.py"), "print('hi')");
				const session: ToolSession = {
					cwd,
					hasUI: false,
					getSessionFile: () => null,
					getSessionSpawns: () => "*",
					settings: Settings.isolated({ "debug.enabled": true }),
				};
				const tool = new DebugTool(session);

				await expect(
					tool.execute("call", { action: "launch", program: "main.py", adapter: "debugpy" }),
				).rejects.toThrow(/debugpy.*python not found in PATH/);
			} finally {
				await removeWithRetries(cwd);
			}
		} finally {
			launchSpy.mockRestore();
		}
	});

	it("throws targeted 'python not found in PATH' when adapter:'debugpy' is unresolvable for attach", async () => {
		const attachSpy = spyOn(dapModule, "selectAttachAdapter").mockReturnValue(null);
		try {
			const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-debug-debugpy-attach-"));
			try {
				const session: ToolSession = {
					cwd,
					hasUI: false,
					getSessionFile: () => null,
					getSessionSpawns: () => "*",
					settings: Settings.isolated({ "debug.enabled": true }),
				};
				const tool = new DebugTool(session);

				await expect(tool.execute("call", { action: "attach", pid: 1234, adapter: "debugpy" })).rejects.toThrow(
					/debugpy.*python not found in PATH/,
				);
			} finally {
				await removeWithRetries(cwd);
			}
		} finally {
			attachSpy.mockRestore();
		}
	});

	it("falls back to the generic 'No debugger adapter' error when adapter is unspecified", async () => {
		const launchSpy = spyOn(dapModule, "selectLaunchAdapter").mockReturnValue(null);
		try {
			const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-debug-noadapter-"));
			try {
				await fs.writeFile(path.join(cwd, "main.py"), "print('hi')");
				const session: ToolSession = {
					cwd,
					hasUI: false,
					getSessionFile: () => null,
					getSessionSpawns: () => "*",
					settings: Settings.isolated({ "debug.enabled": true }),
				};
				const tool = new DebugTool(session);

				await expect(tool.execute("call", { action: "launch", program: "main.py" })).rejects.toThrow(
					/No debugger adapter available/,
				);
			} finally {
				await removeWithRetries(cwd);
			}
		} finally {
			launchSpy.mockRestore();
		}
	});
});
