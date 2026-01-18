import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as shell from "../utils/shell";
import * as shellSnapshot from "../utils/shell-snapshot";
import { PythonKernel } from "./python-kernel";
import { PYTHON_PRELUDE } from "./python-prelude";

class FakeWebSocket {
	static OPEN = 1;
	static CLOSED = 3;
	readyState = FakeWebSocket.OPEN;
	binaryType = "arraybuffer";
	url: string;
	onopen?: () => void;
	onerror?: (event: unknown) => void;
	onclose?: () => void;
	onmessage?: (event: { data: ArrayBuffer }) => void;

	constructor(url: string) {
		this.url = url;
		queueMicrotask(() => {
			this.onopen?.();
		});
	}

	send(_data: ArrayBuffer) {}

	close() {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.();
	}
}

describe("PythonKernel.start (local gateway)", () => {
	const originalEnv = { ...process.env };
	const originalFetch = globalThis.fetch;
	const originalWebSocket = globalThis.WebSocket;

	beforeEach(() => {
		process.env.BUN_ENV = "test";
		delete process.env.OMP_PYTHON_GATEWAY_URL;
		delete process.env.OMP_PYTHON_GATEWAY_TOKEN;
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	});

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) {
				delete process.env[key];
			}
		}
		for (const [key, value] of Object.entries(originalEnv)) {
			process.env[key] = value;
		}
		globalThis.fetch = originalFetch;
		globalThis.WebSocket = originalWebSocket;
		vi.restoreAllMocks();
	});

	it("filters environment variables before spawning gateway", async () => {
		const fetchSpy = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/api/kernelspecs")) {
				return new Response(JSON.stringify({}), { status: 200 });
			}
			if (url.endsWith("/api/kernels") && init?.method === "POST") {
				return new Response(JSON.stringify({ id: "kernel-1" }), { status: 201 });
			}
			return new Response("", { status: 200 });
		});
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		const shellSpy = vi.spyOn(shell, "getShellConfig").mockResolvedValue({
			shell: "/bin/bash",
			args: ["-lc"],
			env: {
				PATH: "/bin",
				HOME: "/home/test",
				OPENAI_API_KEY: "secret",
				UNSAFE_TOKEN: "nope",
				OMP_CUSTOM: "1",
				LC_ALL: "en_US.UTF-8",
			},
			prefix: undefined,
		});
		const snapshotSpy = vi.spyOn(shellSnapshot, "getOrCreateSnapshot").mockResolvedValue(null);
		const whichSpy = vi.spyOn(Bun, "which").mockReturnValue("/usr/bin/python");

		let spawnEnv: Record<string, string | undefined> | undefined;
		let spawnArgs: string[] | undefined;
		const spawnSpy = vi.spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
			const [cmd, options] = args as [string[] | { cmd: string[] }, { env?: Record<string, string | undefined> }?];
			spawnArgs = Array.isArray(cmd) ? cmd : cmd.cmd;
			spawnEnv = options?.env;
			return { pid: 1234, exited: Promise.resolve(0) } as unknown as Bun.Subprocess;
		}) as unknown as typeof Bun.spawn);

		const executeSpy = vi
			.spyOn(PythonKernel.prototype, "execute")
			.mockResolvedValue({ status: "ok", cancelled: false, timedOut: false, stdinRequested: false });

		const kernel = await PythonKernel.start({ cwd: "/tmp/project", env: { CUSTOM_VAR: "ok" } });

		const createCall = fetchSpy.mock.calls.find(([input, init]) => {
			const url = typeof input === "string" ? input : input.toString();
			return url.endsWith("/api/kernels") && init?.method === "POST";
		});
		expect(createCall).toBeDefined();
		if (createCall) {
			expect(JSON.parse(String(createCall[1]?.body ?? "{}"))).toEqual({ name: "python3" });
		}

		expect(spawnArgs).toContain("kernel_gateway");
		expect(spawnEnv?.PATH).toBe("/bin");
		expect(spawnEnv?.HOME).toBe("/home/test");
		expect(spawnEnv?.OMP_CUSTOM).toBe("1");
		expect(spawnEnv?.LC_ALL).toBe("en_US.UTF-8");
		expect(spawnEnv?.CUSTOM_VAR).toBe("ok");
		expect(spawnEnv?.OPENAI_API_KEY).toBeUndefined();
		expect(spawnEnv?.UNSAFE_TOKEN).toBeUndefined();
		expect(spawnEnv?.PYTHONPATH).toBe("/tmp/project");

		expect(executeSpy).toHaveBeenCalledWith(
			PYTHON_PRELUDE,
			expect.objectContaining({
				silent: true,
				storeHistory: false,
			}),
		);

		await kernel.shutdown();

		shellSpy.mockRestore();
		snapshotSpy.mockRestore();
		whichSpy.mockRestore();
		spawnSpy.mockRestore();
		executeSpy.mockRestore();
	});
});
