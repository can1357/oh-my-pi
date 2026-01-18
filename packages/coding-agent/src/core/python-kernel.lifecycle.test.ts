import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { PythonKernel } from "./python-kernel";

type SpawnOptions = Parameters<typeof Bun.spawn>[1];

type FetchCall = { url: string; init?: RequestInit };

type FetchResponse = {
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
	text: () => Promise<string>;
};

type MockEnvironment = {
	fetchCalls: FetchCall[];
	spawnCalls: { cmd: string[]; options: SpawnOptions }[];
};

type MessageEventPayload = { data: ArrayBuffer };

type WebSocketHandler = (event: unknown) => void;

type WebSocketMessageHandler = (event: MessageEventPayload) => void;

class FakeWebSocket {
	static OPEN = 1;
	static CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	readyState = FakeWebSocket.OPEN;
	binaryType = "arraybuffer";
	url: string;
	sent: ArrayBuffer[] = [];

	onopen: WebSocketHandler | null = null;
	onerror: WebSocketHandler | null = null;
	onclose: WebSocketHandler | null = null;
	onmessage: WebSocketMessageHandler | null = null;

	constructor(url: string) {
		this.url = url;
		FakeWebSocket.instances.push(this);
		queueMicrotask(() => {
			this.onopen?.(undefined);
		});
	}

	send(data: ArrayBuffer): void {
		this.sent.push(data);
	}

	close(): void {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.(undefined);
	}
}

const createResponse = (options: { ok: boolean; status?: number; json?: unknown; text?: string }): FetchResponse => {
	return {
		ok: options.ok,
		status: options.status ?? (options.ok ? 200 : 500),
		json: async () => options.json ?? {},
		text: async () => options.text ?? "",
	};
};

const createTempDir = () => mkdtempSync(join(tmpdir(), "omp-python-kernel-"));

const createFakeProcess = (): Subprocess => {
	const exited = new Promise<number>(() => undefined);
	return { pid: 999999, exited } as Subprocess;
};

describe("PythonKernel gateway lifecycle", () => {
	const originalFetch = globalThis.fetch;
	const originalWebSocket = globalThis.WebSocket;
	const originalSpawn = Bun.spawn;
	const originalSleep = Bun.sleep;
	const originalWhich = Bun.which;
	const originalExecute = PythonKernel.prototype.execute;
	const originalGatewayUrl = process.env.OMP_PYTHON_GATEWAY_URL;
	const originalGatewayToken = process.env.OMP_PYTHON_GATEWAY_TOKEN;
	const originalBunEnv = process.env.BUN_ENV;

	let tempDir: string;
	let env: MockEnvironment;

	beforeEach(() => {
		tempDir = createTempDir();
		env = { fetchCalls: [], spawnCalls: [] };

		process.env.BUN_ENV = "test";
		delete process.env.OMP_PYTHON_GATEWAY_URL;
		delete process.env.OMP_PYTHON_GATEWAY_TOKEN;

		FakeWebSocket.instances = [];
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

		Bun.spawn = ((cmd: string[] | string, options?: SpawnOptions) => {
			const normalized = Array.isArray(cmd) ? cmd : [cmd];
			env.spawnCalls.push({ cmd: normalized, options: options ?? {} });
			return createFakeProcess();
		}) as typeof Bun.spawn;

		Bun.sleep = (async () => undefined) as typeof Bun.sleep;

		Bun.which = (() => "/usr/bin/python") as typeof Bun.which;

		Object.defineProperty(PythonKernel.prototype, "execute", {
			value: (async () => ({
				status: "ok",
				cancelled: false,
				timedOut: false,
				stdinRequested: false,
			})) as typeof PythonKernel.prototype.execute,
			configurable: true,
		});
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}

		if (originalBunEnv === undefined) {
			delete process.env.BUN_ENV;
		} else {
			process.env.BUN_ENV = originalBunEnv;
		}
		if (originalGatewayUrl === undefined) {
			delete process.env.OMP_PYTHON_GATEWAY_URL;
		} else {
			process.env.OMP_PYTHON_GATEWAY_URL = originalGatewayUrl;
		}
		if (originalGatewayToken === undefined) {
			delete process.env.OMP_PYTHON_GATEWAY_TOKEN;
		} else {
			process.env.OMP_PYTHON_GATEWAY_TOKEN = originalGatewayToken;
		}

		globalThis.fetch = originalFetch;
		globalThis.WebSocket = originalWebSocket;

		Bun.spawn = originalSpawn;
		Bun.sleep = originalSleep;
		Bun.which = originalWhich;
		Object.defineProperty(PythonKernel.prototype, "execute", { value: originalExecute, configurable: true });
	});

	it("starts local gateway, polls readiness, interrupts, and shuts down", async () => {
		let kernelspecAttempts = 0;
		globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
			const url = String(input);
			env.fetchCalls.push({ url, init });

			if (url.endsWith("/api/kernelspecs")) {
				kernelspecAttempts += 1;
				const ok = kernelspecAttempts >= 2;
				return createResponse({ ok }) as unknown as Response;
			}

			if (url.endsWith("/api/kernels") && init?.method === "POST") {
				return createResponse({ ok: true, json: { id: "kernel-123" } }) as unknown as Response;
			}

			return createResponse({ ok: true }) as unknown as Response;
		}) as typeof fetch;

		const kernel = await PythonKernel.start({ cwd: tempDir, useSharedGateway: false });

		expect(env.spawnCalls).toHaveLength(1);
		expect(env.spawnCalls[0].cmd).toEqual(
			expect.arrayContaining([
				"-m",
				"kernel_gateway",
				"--KernelGatewayApp.allow_origin=*",
				"--JupyterApp.answer_yes=true",
			]),
		);
		expect(env.fetchCalls.filter((call) => call.url.endsWith("/api/kernelspecs"))).toHaveLength(2);
		expect(env.fetchCalls.some((call) => call.url.endsWith("/api/kernels") && call.init?.method === "POST")).toBe(
			true,
		);

		await kernel.interrupt();
		expect(env.fetchCalls.some((call) => call.url.includes("/interrupt") && call.init?.method === "POST")).toBe(true);
		expect(FakeWebSocket.instances[0]?.sent.length).toBe(1);

		await kernel.shutdown();
		expect(env.fetchCalls.some((call) => call.init?.method === "DELETE")).toBe(true);
		expect(kernel.isAlive()).toBe(false);
	});

	it("throws when gateway readiness never succeeds", async () => {
		const originalNow = Date.now;
		let now = 0;
		Date.now = () => {
			now += 1000;
			return now;
		};

		try {
			globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
				const url = String(input);
				env.fetchCalls.push({ url, init });
				if (url.endsWith("/api/kernelspecs")) {
					return createResponse({ ok: false, status: 503 }) as unknown as Response;
				}
				return createResponse({ ok: true }) as unknown as Response;
			}) as typeof fetch;

			await expect(PythonKernel.start({ cwd: tempDir, useSharedGateway: false })).rejects.toThrow(
				"Kernel gateway failed to start",
			);
			expect(env.spawnCalls).toHaveLength(3);
		} finally {
			Date.now = originalNow;
		}
	});

	it("does not throw when shutdown API fails", async () => {
		let kernelspecAttempts = 0;
		globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
			const url = String(input);
			env.fetchCalls.push({ url, init });
			if (url.endsWith("/api/kernelspecs")) {
				kernelspecAttempts += 1;
				const ok = kernelspecAttempts >= 1;
				return createResponse({ ok }) as unknown as Response;
			}
			if (url.endsWith("/api/kernels") && init?.method === "POST") {
				return createResponse({ ok: true, json: { id: "kernel-456" } }) as unknown as Response;
			}
			if (init?.method === "DELETE") {
				throw new Error("delete failed");
			}
			return createResponse({ ok: true }) as unknown as Response;
		}) as typeof fetch;

		const kernel = await PythonKernel.start({ cwd: tempDir });

		await expect(kernel.shutdown()).resolves.toBeUndefined();
	});
});
