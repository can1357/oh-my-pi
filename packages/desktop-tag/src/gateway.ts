import * as path from "node:path";

import { logger } from "@pk-nerdsaver-ai/pi-utils";

import { CaptureService } from "./context";
import { serializeAgentEvent } from "./events";
import { type CapabilityRegistry, createDefaultRegistry, routeContext, updateAvailability } from "./router";
import type { AgentEvent, AgentWorker, ApprovalDecision, CaptureMode, CaptureRegion, ContextPacket } from "./types";
import { PiWorker } from "./worker";

export interface ServerOptions {
	port: number;
	hostname?: string;
	overlayHtmlPath?: string;
	captureService?: CaptureService;
	registry?: CapabilityRegistry;
	worker?: AgentWorker;
}

interface SocketData {
	taskId?: string;
	pumpAbort?: AbortController;
}

const LOOPBACK_HOSTNAMES: Readonly<Record<string, true>> = { "127.0.0.1": true, localhost: true, "::1": true };

/** Local gateway that serves the overlay and wires it to an {@link AgentWorker}. */
export class TagGatewayServer {
	readonly captureService: CaptureService;
	readonly registry: CapabilityRegistry;
	readonly worker: AgentWorker;
	readonly #options: ServerOptions;
	readonly #activeTasks = new Map<string, { socket: Bun.ServerWebSocket<SocketData>; pumpAbort: AbortController }>();
	readonly #inFlightOperations = new Set<Promise<void>>();
	#server?: Bun.Server<SocketData>;
	#stopPromise?: Promise<void>;
	#overlayHtml?: string;
	#stopping = false;
	constructor(options: ServerOptions) {
		this.#options = options;
		this.captureService = options.captureService ?? new CaptureService();
		this.registry = options.registry ?? createDefaultRegistry();
		this.worker = options.worker ?? new PiWorker();
	}

	start(): Bun.Server<SocketData> {
		if (this.#stopPromise) throw new Error("Desktop tag gateway shutdown is still in progress");
		const hostname = this.#options.hostname ?? "127.0.0.1";
		if (!isLoopbackHostname(hostname)) {
			throw new Error(`Desktop tag gateway must bind to a loopback host, received: ${hostname}`);
		}
		this.#stopping = false;
		const server = Bun.serve<SocketData>({
			port: this.#options.port,
			hostname,
			fetch: (req, server) => this.#handleFetch(req, server),
			websocket: {
				open: ws => {
					logger.debug("Overlay connected");
					ws.data = {} as SocketData;
				},
				message: (ws, message) => {
					if (this.#stopping) return;
					this.#trackSocketOperation(this.#handleSocketMessage(ws, message));
				},
				close: (ws, code, reason) => this.#trackSocketOperation(this.#handleSocketClose(ws, code, reason)),
			},
		});

		this.#server = server;
		logger.info("Tag gateway listening", { url: this.url });
		return server;
	}

	stop(): Promise<void> {
		if (this.#stopPromise) return this.#stopPromise;
		this.#stopping = true;
		const stopping = this.#finishStop();
		this.#stopPromise = stopping;
		void stopping.then(
			() => {
				if (this.#stopPromise === stopping) this.#stopPromise = undefined;
			},
			() => {
				if (this.#stopPromise === stopping) this.#stopPromise = undefined;
			},
		);
		return stopping;
	}

	async #finishStop(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		const sockets = new Set([...this.#activeTasks.values()].map(({ socket }) => socket));
		await Promise.all([...sockets].map(socket => this.#closeTask(socket)));
		await this.#awaitOperations();
		await server?.stop(true);
		await this.#awaitOperations();
	}

	async #awaitOperations(): Promise<void> {
		while (this.#inFlightOperations.size > 0) {
			await Promise.all(this.#inFlightOperations);
		}
	}

	#trackSocketOperation(operation: Promise<void>): void {
		void this.#trackOperation(operation).catch(error => {
			logger.error("Gateway socket operation failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	#trackOperation<T>(operation: Promise<T>): Promise<T> {
		const tracked = operation.then(
			() => undefined,
			() => undefined,
		);
		this.#inFlightOperations.add(tracked);
		void tracked.finally(() => this.#inFlightOperations.delete(tracked));
		return operation;
	}

	get url(): string {
		if (!this.#server) return "";
		return `http://${formatUrlHostname(this.#server.hostname ?? this.#options.hostname ?? "127.0.0.1")}:${this.#server.port ?? this.#options.port}`;
	}

	async #handleFetch(req: Request, server: Bun.Server<SocketData>): Promise<Response | undefined> {
		const url = new URL(req.url);
		const serverPort = server.port;
		if (serverPort === undefined) return new Response("Gateway port unavailable", { status: 503 });

		if (url.pathname === "/ws") {
			if (!isAllowedWebSocketOrigin(req.headers.get("Origin"), url)) {
				return new Response("WebSocket origin forbidden", { status: 403 });
			}
			if (this.#stopping) return new Response("Gateway is shutting down", { status: 503 });
			const upgraded = server.upgrade(req, { data: {} as SocketData });
			if (upgraded) return undefined;
			return new Response("WebSocket upgrade failed", { status: 400 });
		}

		if (url.pathname.startsWith("/api/")) {
			if (!isAllowedWebSocketOrigin(req.headers.get("Origin"), url)) {
				return new Response("Origin forbidden", { status: 403 });
			}
			if (this.#stopping) return new Response("Gateway is shutting down", { status: 503 });
			return this.#handleApi(req, url.pathname);
		}

		if (this.#stopping) return new Response("Gateway is shutting down", { status: 503 });
		const html = await this.#getOverlayHtml();
		return new Response(html, { headers: { "Content-Type": "text/html" } });
	}

	async #handleApi(req: Request, pathname: string): Promise<Response> {
		if (req.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}
		let body: unknown;
		try {
			body = await req.json();
		} catch {
			return new Response("Invalid JSON", { status: 400 });
		}
		if (this.#stopping) return new Response("Gateway is shutting down", { status: 503 });

		if (pathname === "/api/capture") {
			const result = await this.#trackOperation(this.#runCapture(body));
			return Response.json(result, { status: result.ok ? 200 : 400 });
		}

		return new Response("Not found", { status: 404 });
	}

	async #handleSocketMessage(ws: Bun.ServerWebSocket<SocketData>, raw: string | Buffer): Promise<void> {
		if (this.#stopping) return;
		const parsed =
			typeof raw === "string"
				? parseClientMessage(raw)
				: { ok: false as const, error: "expected JSON text message" };
		if (!parsed.ok) {
			ws.send(JSON.stringify({ type: "protocol_error", error: parsed.error }));
			return;
		}
		const message = parsed.message;

		switch (message.type) {
			case "capture": {
				const taskId = crypto.randomUUID();
				await this.#startTask(
					ws,
					taskId,
					message.mode,
					message.request,
					message.includeClipboard ?? true,
					message.region,
				);
				break;
			}
			case "message": {
				if (!ws.data.taskId) return;
				await this.worker.sendMessage(ws.data.taskId, message.text);
				break;
			}
			case "approve": {
				if (!ws.data.taskId) return;
				const decision: ApprovalDecision = {
					allowed: message.allowed,
					scope: message.scope,
				};
				await this.worker.approve(ws.data.taskId, message.actionId, decision);
				break;
			}
			case "cancel": {
				const taskId = this.#detachTask(ws);
				if (taskId) await this.#cancelWorkerTask(taskId);
				break;
			}
		}
	}

	async #startTask(
		ws: Bun.ServerWebSocket<SocketData>,
		taskId: string,
		mode: CaptureMode,
		userRequest: string,
		includeClipboard: boolean,
		region?: CaptureRegion,
	): Promise<void> {
		const previousTaskId = this.#detachTask(ws);
		const abortController = new AbortController();
		ws.data.taskId = taskId;
		ws.data.pumpAbort = abortController;
		this.#activeTasks.set(taskId, { socket: ws, pumpAbort: abortController });
		if (previousTaskId) await this.#cancelWorkerTask(previousTaskId);
		if (!this.#isCurrentTask(ws, taskId)) return;

		try {
			const packet = await this.captureService.capture({ mode, userRequest, includeClipboard, region });
			if (!this.#isCurrentTask(ws, taskId)) return;
			await updateAvailability(this.registry);
			if (!this.#isCurrentTask(ws, taskId)) return;
			const routing = routeContext(this.registry, packet);

			send(ws, { type: "task.started", taskId });
			send(ws, { type: "agent.message.delta", text: routing.message });

			await this.worker.createSession(taskId, { contextPacket: packet, routing });
			if (!this.#isCurrentTask(ws, taskId)) {
				await this.#cancelWorkerTask(taskId);
				return;
			}

			this.#trackSocketOperation(this.#pumpEvents(ws, taskId, abortController.signal));
		} catch (error) {
			if (!this.#isCurrentTask(ws, taskId)) return;
			logger.error("Failed to start desktop task", {
				error: error instanceof Error ? error.message : String(error),
			});
			send(ws, { type: "task.failed", taskId, error: error instanceof Error ? error.message : String(error) });
			await this.#closeTask(ws);
		}
	}

	async #closeTask(ws: Bun.ServerWebSocket<SocketData>): Promise<void> {
		const taskId = this.#detachTask(ws);
		if (taskId) await this.#cancelWorkerTask(taskId);
	}

	#detachTask(ws: Bun.ServerWebSocket<SocketData>): string | undefined {
		const taskId = ws.data.taskId;
		if (!taskId) return undefined;

		ws.data.pumpAbort?.abort();
		ws.data.taskId = undefined;
		ws.data.pumpAbort = undefined;
		this.#activeTasks.delete(taskId);
		return taskId;
	}

	#isCurrentTask(ws: Bun.ServerWebSocket<SocketData>, taskId: string): boolean {
		return ws.data.taskId === taskId && !ws.data.pumpAbort?.signal.aborted;
	}

	async #cancelWorkerTask(taskId: string): Promise<void> {
		try {
			await this.worker.cancel(taskId);
		} catch (error) {
			logger.debug("Failed to cancel desktop task", {
				taskId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #pumpEvents(ws: Bun.ServerWebSocket<SocketData>, taskId: string, signal: AbortSignal): Promise<void> {
		try {
			for await (const event of this.worker.subscribe(taskId)) {
				if (signal.aborted) return;
				send(ws, event);
			}
		} catch (error) {
			if (signal.aborted) return;
			logger.error("Event pump error", { error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.#activeTasks.delete(taskId);
			if (ws.data.taskId === taskId) {
				ws.data.taskId = undefined;
				ws.data.pumpAbort = undefined;
			}
		}
	}

	async #handleSocketClose(ws: Bun.ServerWebSocket<SocketData>, code: number, reason: string): Promise<void> {
		logger.debug("Overlay disconnected", { code, reason });
		await this.#closeTask(ws);
	}

	async #runCapture(body: unknown): Promise<{ ok: boolean; taskId?: string; error?: string; packet?: ContextPacket }> {
		const parsed = parseCaptureBody(body);
		if (!parsed.ok) return { ok: false, error: parsed.error };

		try {
			const packet = await this.captureService.capture(parsed.value);
			await updateAvailability(this.registry);
			const routing = routeContext(this.registry, packet);
			const taskId = crypto.randomUUID();
			return { ok: true, taskId, packet, routing: routing as unknown as Record<string, unknown> } as {
				ok: boolean;
				taskId?: string;
				error?: string;
				packet?: ContextPacket;
			};
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async #getOverlayHtml(): Promise<string> {
		if (this.#overlayHtml) return this.#overlayHtml;
		const filePath = this.#options.overlayHtmlPath ?? path.join(import.meta.dir, "overlay.html");
		const file = Bun.file(filePath);
		this.#overlayHtml = await file.text();
		return this.#overlayHtml;
	}
}

function formatUrlHostname(hostname: string): string {
	return hostname.includes(":") ? `[${hostname}]` : hostname;
}

export function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
	return LOOPBACK_HOSTNAMES[normalized.toLowerCase()] === true;
}

export function isAllowedWebSocketOrigin(origin: string | null, requestUrl: string | URL): boolean {
	try {
		const url = typeof requestUrl === "string" ? new URL(requestUrl) : requestUrl;
		if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname)) return false;
		return origin === null || origin === url.origin;
	} catch {
		return false;
	}
}

function send(ws: Bun.ServerWebSocket<SocketData>, event: AgentEvent): void {
	try {
		ws.send(serializeAgentEvent(event));
	} catch (error) {
		logger.debug("Failed to send event to overlay", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

interface ClientCaptureMessage {
	type: "capture";
	mode: CaptureMode;
	request: string;
	includeClipboard?: boolean;
	region?: CaptureRegion;
}

interface ClientTextMessage {
	type: "message";
	text: string;
}

interface ClientApproveMessage {
	type: "approve";
	actionId: string;
	allowed: boolean;
	scope?: "once" | "session";
}

interface ClientCancelMessage {
	type: "cancel";
}

type ClientMessage = ClientCaptureMessage | ClientTextMessage | ClientApproveMessage | ClientCancelMessage;
type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseClientMessage(raw: string): { ok: true; message: ClientMessage } | { ok: false; error: string } {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { ok: false, error: "expected valid JSON text message" };
	}
	if (!isRecord(value) || typeof value.type !== "string")
		return { ok: false, error: "message must be an object with a type" };

	let result: ParseResult<ClientMessage>;
	switch (value.type) {
		case "capture":
			result = parseCaptureMessage(value);
			break;
		case "message":
			result = parseTextMessage(value);
			break;
		case "approve":
			result = parseApproveMessage(value);
			break;
		case "cancel":
			result = hasOnlyKeys(value, ["type"])
				? { ok: true, value: { type: "cancel" } }
				: { ok: false, error: "cancel contains unknown fields" };
			break;
		default:
			return { ok: false, error: "unknown message type" };
	}
	return result.ok ? { ok: true, message: result.value } : result;
}

function parseCaptureMessage(record: Record<string, unknown>): ParseResult<ClientCaptureMessage> {
	if (!hasOnlyKeys(record, ["type", "mode", "request", "includeClipboard", "region"])) {
		return { ok: false, error: "capture contains unknown fields" };
	}
	const capture = parseCaptureFields(record);
	return capture.ok ? { ok: true, value: { type: "capture", ...capture.value } } : capture;
}

function parseTextMessage(record: Record<string, unknown>): ParseResult<ClientTextMessage> {
	if (!hasOnlyKeys(record, ["type", "text"])) return { ok: false, error: "message contains unknown fields" };
	if (typeof record.text !== "string" || !record.text.trim())
		return { ok: false, error: "text must be a non-empty string" };
	return { ok: true, value: { type: "message", text: record.text } };
}

function parseApproveMessage(record: Record<string, unknown>): ParseResult<ClientApproveMessage> {
	if (record.editedArguments !== undefined) {
		return { ok: false, error: "editedArguments are not supported by the desktop-tag worker" };
	}
	if (!hasOnlyKeys(record, ["type", "actionId", "allowed", "scope"])) {
		return { ok: false, error: "approve contains unknown fields" };
	}
	if (typeof record.actionId !== "string" || !record.actionId.trim()) {
		return { ok: false, error: "actionId must be a non-empty string" };
	}
	if (typeof record.allowed !== "boolean") return { ok: false, error: "allowed must be a boolean" };
	const scope = record.scope;
	if (scope !== undefined && scope !== "once" && scope !== "session") {
		return { ok: false, error: "scope must be once or session" };
	}
	return {
		ok: true,
		value: {
			type: "approve",
			actionId: record.actionId,
			allowed: record.allowed,
			scope,
		},
	};
}

function parseCaptureBody(body: unknown): ParseResult<{
	mode: CaptureMode;
	userRequest: string;
	includeClipboard: boolean;
	region?: CaptureRegion;
}> {
	if (!isRecord(body)) return { ok: false, error: "body must be an object" };
	if (!hasOnlyKeys(body, ["mode", "request", "includeClipboard", "region"])) {
		return { ok: false, error: "body contains unknown fields" };
	}
	const parsed = parseCaptureFields(body);
	if (!parsed.ok) return parsed;
	return {
		ok: true,
		value: {
			mode: parsed.value.mode,
			userRequest: parsed.value.request,
			includeClipboard: parsed.value.includeClipboard ?? true,
			region: parsed.value.region,
		},
	};
}

function parseCaptureFields(record: Record<string, unknown>): ParseResult<Omit<ClientCaptureMessage, "type">> {
	const mode = record.mode;
	if (typeof mode !== "string" || !["screen", "window", "region", "browser"].includes(mode)) {
		return { ok: false, error: "mode must be one of screen, window, region, browser" };
	}
	if (typeof record.request !== "string" || !record.request.trim()) {
		return { ok: false, error: "request must be a non-empty string" };
	}
	if (record.includeClipboard !== undefined && typeof record.includeClipboard !== "boolean") {
		return { ok: false, error: "includeClipboard must be a boolean" };
	}
	const region = parseRegion(record.region, mode === "region");
	if (!region.ok) return region;
	return {
		ok: true,
		value: {
			mode: mode as CaptureMode,
			request: record.request,
			includeClipboard: record.includeClipboard as boolean | undefined,
			region: region.value,
		},
	};
}

function parseRegion(value: unknown, required: boolean): ParseResult<CaptureRegion | undefined> {
	if (value === undefined) {
		return required ? { ok: false, error: "region is required for region capture" } : { ok: true, value: undefined };
	}
	if (!isRecord(value) || !hasOnlyKeys(value, ["x", "y", "width", "height"])) {
		return { ok: false, error: "region must contain only x, y, width, and height" };
	}
	for (const key of ["x", "y"] as const) {
		if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
			return { ok: false, error: `region ${key} must be a finite number` };
		}
	}
	for (const key of ["width", "height"] as const) {
		if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] <= 0) {
			return { ok: false, error: `region ${key} must be a finite positive number` };
		}
	}
	return { ok: true, value: value as unknown as CaptureRegion };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(record).every(key => allowed.includes(key));
}
