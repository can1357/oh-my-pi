import { describe, expect, it } from "bun:test";

import { type CaptureOptions, CaptureService } from "../src/context";
import { isAllowedWebSocketOrigin, isLoopbackHostname, TagGatewayServer } from "../src/gateway";
import type { AgentEvent, AgentWorker, ApprovalDecision, ContextPacket, SessionHandle, TaskInput } from "../src/types";

class FixedCaptureService extends CaptureService {
	override async capture(options: CaptureOptions): Promise<ContextPacket> {
		return {
			captureId: crypto.randomUUID(),
			timestamp: new Date().toISOString(),
			userRequest: options.userRequest,
			captureMode: options.mode,
			visual: { displayScale: 1, annotations: [] },
			foregroundApp: {},
			browser: {},
			selection: {},
			availableCapabilities: [],
		};
	}
}
class BlockingCaptureService extends FixedCaptureService {
	readonly started = Promise.withResolvers<void>();
	readonly release = Promise.withResolvers<void>();
	readonly completed = Promise.withResolvers<void>();
	calls = 0;

	override async capture(options: CaptureOptions): Promise<ContextPacket> {
		this.calls += 1;
		this.started.resolve();
		await this.release.promise;
		try {
			return await super.capture(options);
		} finally {
			this.completed.resolve();
		}
	}
}

class RecordingWorker implements AgentWorker {
	readonly sessions: string[] = [];
	readonly cancellations: string[] = [];
	readonly approvals: Array<{ sessionId: string; actionId: string; decision: ApprovalDecision }> = [];
	readonly #subscriptionClosers = new Map<string, () => void>();
	readonly #cancelled = new Set<string>();
	readonly #sessionWaiters: Array<(sessionId: string) => void> = [];
	readonly #cancellationWaiters: Array<(sessionId: string) => void> = [];
	readonly #cancelBlock?: Promise<void>;

	constructor(cancelBlock?: Promise<void>) {
		this.#cancelBlock = cancelBlock;
	}

	async createSession(taskId: string, _input: TaskInput): Promise<SessionHandle> {
		this.sessions.push(taskId);
		this.#sessionWaiters.shift()?.(taskId);
		return { sessionId: taskId };
	}

	nextSession(): Promise<string> {
		const next = Promise.withResolvers<string>();
		this.#sessionWaiters.push(next.resolve);
		return next.promise;
	}

	nextCancellation(): Promise<string> {
		const next = Promise.withResolvers<string>();
		this.#cancellationWaiters.push(next.resolve);
		return next.promise;
	}

	async sendMessage(_sessionId: string, _message: string): Promise<void> {}

	async approve(sessionId: string, actionId: string, decision: ApprovalDecision): Promise<void> {
		this.approvals.push({ sessionId, actionId, decision });
	}

	async cancel(sessionId: string): Promise<void> {
		if (this.#cancelled.has(sessionId)) return;
		this.#cancelled.add(sessionId);
		this.cancellations.push(sessionId);
		this.#cancellationWaiters.shift()?.(sessionId);
		await this.#cancelBlock;
		this.#subscriptionClosers.get(sessionId)?.();
		this.#subscriptionClosers.delete(sessionId);
	}

	subscribe(sessionId: string): AsyncIterable<AgentEvent> {
		const closed = Promise.withResolvers<void>();
		this.#subscriptionClosers.set(sessionId, closed.resolve);
		return {
			[Symbol.asyncIterator]() {
				return {
					async next(): Promise<IteratorResult<AgentEvent>> {
						await closed.promise;
						return { done: true, value: undefined };
					},
				};
			},
		};
	}
}

async function connect(url: string): Promise<WebSocket> {
	const opened = Promise.withResolvers<void>();
	const ws = new WebSocket(`${url.replace("http:", "ws:")}/ws`);
	ws.addEventListener("open", () => opened.resolve(), { once: true });
	ws.addEventListener("error", () => opened.reject(new Error("WebSocket connection failed")), { once: true });
	await opened.promise;
	return ws;
}

function nextSocketMessageOfType(ws: WebSocket, type: string): Promise<Record<string, unknown>> {
	const received = Promise.withResolvers<Record<string, unknown>>();
	const onMessage = (event: MessageEvent): void => {
		try {
			const message = JSON.parse(String(event.data)) as Record<string, unknown>;
			if (message.type !== type) return;
			ws.removeEventListener("message", onMessage);
			received.resolve(message);
		} catch (error) {
			ws.removeEventListener("message", onMessage);
			received.reject(error);
		}
	};
	ws.addEventListener("message", onMessage);
	return received.promise;
}

async function stopGateway(gateway: TagGatewayServer, ws: WebSocket): Promise<void> {
	await gateway.stop();
	if (ws.readyState !== WebSocket.CLOSED) ws.close();
}

describe("gateway network security", () => {
	it("accepts only explicit loopback bind hosts", () => {
		expect(isLoopbackHostname("127.0.0.1")).toBe(true);
		expect(isLoopbackHostname("LOCALHOST")).toBe(true);
		expect(isLoopbackHostname("::1")).toBe(true);
		expect(isLoopbackHostname("[::1]")).toBe(true);
		expect(isLoopbackHostname("0.0.0.0")).toBe(false);
		expect(isLoopbackHostname("192.168.1.10")).toBe(false);

		const gateway = new TagGatewayServer({ port: 0, hostname: "0.0.0.0" });
		expect(() => gateway.start()).toThrow("must bind to a loopback host");
	});

	it("allows native clients only on loopback URLs and requires exact browser same-origin", () => {
		const localhostUrl = "http://localhost:18087/ws";
		expect(isAllowedWebSocketOrigin(null, localhostUrl)).toBe(true);
		expect(isAllowedWebSocketOrigin("http://localhost:18087", localhostUrl)).toBe(true);
		expect(isAllowedWebSocketOrigin("http://127.0.0.1:18087", localhostUrl)).toBe(false);
		expect(isAllowedWebSocketOrigin("http://[::1]:18087", localhostUrl)).toBe(false);
		expect(isAllowedWebSocketOrigin("https://localhost:18087", localhostUrl)).toBe(false);
		expect(isAllowedWebSocketOrigin("http://localhost:18088", localhostUrl)).toBe(false);
		expect(isAllowedWebSocketOrigin("http://localhost:18087/not-an-origin", localhostUrl)).toBe(false);
		expect(isAllowedWebSocketOrigin(null, "http://192.168.1.10:18087/ws")).toBe(false);
		expect(isAllowedWebSocketOrigin("https://attacker.example", localhostUrl)).toBe(false);
		expect(isAllowedWebSocketOrigin("not an origin", localhostUrl)).toBe(false);
	});

	it("rejects cross-site and cross-host-alias requests", async () => {
		const gateway = new TagGatewayServer({ port: 0 });
		gateway.start();
		try {
			const attackerHeaders = { Origin: "https://attacker.example" };
			const websocketResponse = await fetch(`${gateway.url}/ws`, { headers: attackerHeaders });
			expect(websocketResponse.status).toBe(403);
			const aliasOrigin = gateway.url.replace("127.0.0.1", "localhost");
			const aliasResponse = await fetch(`${gateway.url}/api/capture`, {
				method: "POST",
				headers: { Origin: aliasOrigin },
				body: JSON.stringify({ mode: "screen", request: "capture the victim's screen" }),
			});
			expect(aliasResponse.status).toBe(403);
		} finally {
			await gateway.stop();
		}
	});
});

describe("gateway task lifecycle", () => {
	it("cancels replaced and explicitly cancelled tasks", async () => {
		const worker = new RecordingWorker();
		const gateway = new TagGatewayServer({ port: 0, captureService: new FixedCaptureService(), worker });
		gateway.start();
		const ws = await connect(gateway.url);

		try {
			const firstSession = worker.nextSession();
			ws.send(JSON.stringify({ type: "capture", mode: "screen", request: "explain first" }));
			const firstTaskId = await firstSession;

			const replacedTask = worker.nextCancellation();
			const secondSession = worker.nextSession();
			ws.send(JSON.stringify({ type: "capture", mode: "screen", request: "explain second" }));
			const [replacedTaskId, secondTaskId] = await Promise.all([replacedTask, secondSession]);
			expect(replacedTaskId).toBe(firstTaskId);

			const cancelledTask = worker.nextCancellation();
			ws.send(JSON.stringify({ type: "cancel" }));
			expect(await cancelledTask).toBe(secondTaskId);
			expect(worker.cancellations.filter(taskId => taskId === firstTaskId)).toHaveLength(1);
			expect(worker.cancellations.filter(taskId => taskId === secondTaskId)).toHaveLength(1);
		} finally {
			await stopGateway(gateway, ws);
		}
	});

	it("rejects malformed approval fields without dispatching", async () => {
		const worker = new RecordingWorker();
		const gateway = new TagGatewayServer({ port: 0, captureService: new FixedCaptureService(), worker });
		gateway.start();
		const ws = await connect(gateway.url);
		try {
			const session = worker.nextSession();
			ws.send(JSON.stringify({ type: "capture", mode: "screen", request: "inspect this" }));
			await session;

			const protocolError = nextSocketMessageOfType(ws, "protocol_error");
			ws.send(JSON.stringify({ type: "approve", actionId: "dangerous", allowed: "false" }));
			expect(await protocolError).toMatchObject({ type: "protocol_error", error: "allowed must be a boolean" });

			const editedArgumentsError = nextSocketMessageOfType(ws, "protocol_error");
			ws.send(
				JSON.stringify({
					type: "approve",
					actionId: "dangerous",
					allowed: true,
					editedArguments: { command: "safe-command" },
				}),
			);
			expect(await editedArgumentsError).toMatchObject({
				type: "protocol_error",
				error: "editedArguments are not supported by the desktop-tag worker",
			});

			const scopeError = nextSocketMessageOfType(ws, "protocol_error");
			ws.send(JSON.stringify({ type: "approve", actionId: "dangerous", allowed: true, scope: "group" }));
			expect(await scopeError).toMatchObject({ type: "protocol_error", error: "scope must be once or session" });
			expect(worker.approvals).toEqual([]);
		} finally {
			await stopGateway(gateway, ws);
		}
	});

	it("detaches a cancelled task before capture can create a session", async () => {
		const captureService = new BlockingCaptureService();
		const worker = new RecordingWorker();
		const gateway = new TagGatewayServer({ port: 0, captureService, worker });
		gateway.start();
		const ws = await connect(gateway.url);
		try {
			ws.send(JSON.stringify({ type: "capture", mode: "screen", request: "wait for capture" }));
			await captureService.started.promise;
			const cancelled = worker.nextCancellation();
			ws.send(JSON.stringify({ type: "cancel" }));
			await cancelled;
			captureService.release.resolve();
			await captureService.completed.promise;
			await gateway.stop();
			expect(worker.sessions).toEqual([]);
		} finally {
			captureService.release.resolve();
			ws.close();
			await gateway.stop();
		}
	});

	it("waits for blocked capture startup before shutdown completes", async () => {
		const captureService = new BlockingCaptureService();
		const worker = new RecordingWorker();
		const gateway = new TagGatewayServer({ port: 0, captureService, worker });
		gateway.start();
		const ws = await connect(gateway.url);
		const gatewayUrl = gateway.url;
		ws.send(JSON.stringify({ type: "capture", mode: "screen", request: "block during shutdown" }));
		await captureService.started.promise;

		const cancellation = worker.nextCancellation();
		let stopped = false;
		const stopping = gateway.stop().then(() => {
			stopped = true;
		});
		try {
			await cancellation;
			expect(stopped).toBe(false);
			const captureResponse = await fetch(`${gatewayUrl}/api/capture`, {
				method: "POST",
				headers: { Origin: gatewayUrl },
				body: JSON.stringify({ mode: "screen", request: "must not start" }),
			});
			expect(captureResponse.status).toBe(503);
			expect(captureService.calls).toBe(1);
			captureService.release.resolve();
			await captureService.completed.promise;
			await stopping;
			expect(stopped).toBe(true);
			expect(worker.sessions).toEqual([]);
		} finally {
			captureService.release.resolve();
			await stopping;
			ws.close();
		}
	});

	it("awaits active task cancellation before shutdown completes", async () => {
		const cancelRelease = Promise.withResolvers<void>();
		const worker = new RecordingWorker(cancelRelease.promise);
		const gateway = new TagGatewayServer({ port: 0, captureService: new FixedCaptureService(), worker });
		gateway.start();
		const ws = await connect(gateway.url);
		const session = worker.nextSession();
		ws.send(JSON.stringify({ type: "capture", mode: "screen", request: "stay active" }));
		await session;

		const cancellation = worker.nextCancellation();
		let stopped = false;
		const stopping = gateway.stop().then(() => {
			stopped = true;
		});
		await cancellation;
		expect(stopped).toBe(false);
		cancelRelease.resolve();
		await stopping;
		expect(stopped).toBe(true);
		ws.close();
	});

	it("renders approval content only through text nodes", async () => {
		const html = await Bun.file(new URL("../src/overlay.html", import.meta.url)).text();
		expect(html).not.toContain("innerHTML");
		expect(html).toContain("tool.textContent = String(req.toolName");
		expect(html).toContain("effects.textContent = String(req.effects");
		expect(html).toContain("argumentsEl.textContent = JSON.stringify(req.arguments");
	});
});
