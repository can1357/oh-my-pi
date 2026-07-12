/**
 * HTTP surface for the capture workflow, mounted by TagGatewayServer under
 * /api/capture/*. Follows the gateway's conventions: loopback binding, JSON
 * bodies, hand-validated input. Event delivery uses server-sent events —
 * the run/event stream itself stays typed end to end.
 */
import type { ImageContent } from "@pk-nerdsaver-ai/pi-ai";

import type { CaptureOrchestrator } from "./orchestrator";
import type { TelegramBridge } from "./telegram";
import { timingSafeEqualString } from "./telegram";
import type { CaptureRun } from "./types";

export interface CaptureHttpOptions {
	orchestrator: CaptureOrchestrator;
	telegram?: TelegramBridge;
	/** When set, every route except the Telegram webhook requires this bearer token. */
	gatewayToken?: string;
	/** Upper bound for request bodies; screenshot uploads dominate this. */
	maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
const RUN_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status });
}

function errorResponse(message: string, status: number): Response {
	return json({ error: message }, status);
}

/** Public projection of a capture run — never exposes filesystem paths. */
function projectRun(run: CaptureRun): Record<string, unknown> {
	const { sessionFile: _sessionFile, ...rest } = run;
	return { ...rest };
}

export class CaptureHttpRouter {
	readonly #orchestrator: CaptureOrchestrator;
	readonly #telegram: TelegramBridge | undefined;
	readonly #gatewayToken: string | undefined;
	readonly #maxBodyBytes: number;

	constructor(options: CaptureHttpOptions) {
		this.#orchestrator = options.orchestrator;
		this.#telegram = options.telegram;
		this.#gatewayToken = options.gatewayToken;
		this.#maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
	}

	/** Handle a request under /api/capture/. Returns undefined for unknown paths. */
	async handle(request: Request, pathname: string): Promise<Response | undefined> {
		if (!pathname.startsWith("/api/capture/")) return undefined;
		const segments = pathname.split("/").filter(Boolean).slice(2); // after ["api", "capture"]
		const method = request.method;

		if (segments[0] === "telegram" && segments[1] === "webhook" && segments.length === 2) {
			if (method !== "POST") return errorResponse("Method not allowed", 405);
			if (!this.#telegram) return errorResponse("Telegram bridge is not enabled", 404);
			return this.#telegram.handleWebhookRequest(request);
		}

		const authFailure = this.#authorize(request);
		if (authFailure) return authFailure;

		if (segments[0] === "tasks" && segments.length === 1) {
			if (method === "POST") return this.#createTask(request);
			if (method === "GET") return json({ tasks: this.#orchestrator.listRuns().map(projectRun) });
			return errorResponse("Method not allowed", 405);
		}

		if (segments[0] === "tasks" && segments.length >= 2) {
			const runId = segments[1] ?? "";
			if (!RUN_ID_PATTERN.test(runId)) return errorResponse("Invalid task id", 400);

			if (segments.length === 2 && method === "GET") return this.#getTask(runId);
			if (segments.length === 3 && segments[2] === "follow-up" && method === "POST") {
				return this.#followUp(runId, request);
			}
			if (segments.length === 3 && segments[2] === "cancel" && method === "POST") {
				const result = await this.#orchestrator.cancel(runId, "api");
				return result.accepted
					? json({ ok: true, task: result.run ? projectRun(result.run) : undefined })
					: errorResponse(result.reason ?? "Could not cancel", result.run ? 409 : 404);
			}
			return errorResponse("Not found", 404);
		}

		if (segments[0] === "sessions" && segments.length === 1 && method === "GET") {
			// Sessions the capture workflow knows about, newest first, for the "continue existing" picker.
			const sessions = this.#orchestrator
				.listRuns(100)
				.filter(run => run.sessionId !== undefined)
				.map(run => ({
					sessionId: run.sessionId,
					runId: run.id,
					instruction: run.instruction.slice(0, 120),
					status: run.status,
					updatedAt: run.updatedAt,
				}));
			return json({ sessions });
		}

		if (segments[0] === "runners" && segments.length === 1 && method === "GET") {
			return json({ runners: await this.#orchestrator.listRunners() });
		}

		if (segments[0] === "events" && segments.length === 2 && method === "GET") {
			const runId = segments[1] ?? "";
			if (!RUN_ID_PATTERN.test(runId)) return errorResponse("Invalid task id", 400);
			return this.#streamEvents(runId, request);
		}

		return errorResponse("Not found", 404);
	}

	#authorize(request: Request): Response | undefined {
		if (!this.#gatewayToken) return undefined;
		const header = request.headers.get("Authorization") ?? "";
		const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
		if (!timingSafeEqualString(token, this.#gatewayToken)) {
			return errorResponse("Unauthorized", 401);
		}
		return undefined;
	}

	async #readJsonBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
		const contentLength = Number(request.headers.get("Content-Length") ?? "0");
		if (Number.isFinite(contentLength) && contentLength > this.#maxBodyBytes) {
			return { ok: false, response: errorResponse("Request body too large", 413) };
		}
		try {
			const text = await request.text();
			if (text.length > this.#maxBodyBytes) {
				return { ok: false, response: errorResponse("Request body too large", 413) };
			}
			return { ok: true, value: JSON.parse(text) };
		} catch {
			return { ok: false, response: errorResponse("Invalid JSON", 400) };
		}
	}

	async #createTask(request: Request): Promise<Response> {
		const body = await this.#readJsonBody(request);
		if (!body.ok) return body.response;
		const result = await this.#orchestrator.submitTask(body.value);
		if (!result.ok) return errorResponse(result.error, 400);
		return json({ task: projectRun(result.value) }, 202);
	}

	#getTask(runId: string): Response {
		const run = this.#orchestrator.getRun(runId);
		if (!run) return errorResponse("Not found", 404);
		const events = this.#orchestrator.store.listEvents(runId).map(entry => ({ at: entry.at, ...entry.event }));
		return json({ task: projectRun(run), events });
	}

	async #followUp(runId: string, request: Request): Promise<Response> {
		const body = await this.#readJsonBody(request);
		if (!body.ok) return body.response;
		const value = body.value as { text?: unknown; images?: unknown; participant?: unknown } | null;
		if (!value || typeof value.text !== "string" || value.text.trim().length === 0) {
			return errorResponse("text must be a non-empty string", 400);
		}
		const images = parseImages(value.images);
		if (typeof images === "string") return errorResponse(images, 400);
		const result = await this.#orchestrator.followUp(runId, {
			text: value.text,
			...(images && images.length > 0 ? { images } : {}),
			source: "api",
			...(typeof value.participant === "string" ? { participant: value.participant } : {}),
		});
		if (!result.accepted) {
			return errorResponse(result.reason ?? "Follow-up rejected", result.run ? 409 : 404);
		}
		return json({ ok: true, task: result.run ? projectRun(result.run) : undefined }, 202);
	}

	#streamEvents(runId: string, request: Request): Response {
		const run = this.#orchestrator.getRun(runId);
		if (!run) return errorResponse("Not found", 404);
		const abort = new AbortController();
		request.signal.addEventListener("abort", () => abort.abort(), { once: true });
		const iterable = this.#orchestrator.subscribeEvents(runId, abort.signal);
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				try {
					for await (const event of iterable) {
						controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
					}
					controller.enqueue(encoder.encode("event: end\ndata: {}\n\n"));
				} catch {
					// Client went away or the run channel failed; just end the stream.
				} finally {
					try {
						controller.close();
					} catch {
						// Already closed by cancellation.
					}
				}
			},
			cancel() {
				abort.abort();
			},
		});
		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	}
}

const MAX_FOLLOW_UP_IMAGES = 8;
const MAX_IMAGE_DATA_CHARS = 28 * 1024 * 1024;

function parseImages(value: unknown): ImageContent[] | undefined | string {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > MAX_FOLLOW_UP_IMAGES) {
		return `images must be an array of at most ${MAX_FOLLOW_UP_IMAGES} items`;
	}
	const images: ImageContent[] = [];
	for (const item of value) {
		if (
			typeof item !== "object" ||
			item === null ||
			(item as { type?: unknown }).type !== "image" ||
			typeof (item as { data?: unknown }).data !== "string" ||
			typeof (item as { mimeType?: unknown }).mimeType !== "string"
		) {
			return 'images entries must be { type: "image", data, mimeType }';
		}
		const data = (item as { data: string }).data;
		if (data.length > MAX_IMAGE_DATA_CHARS) return "an image exceeds the upload limit";
		images.push({ type: "image", data, mimeType: (item as { mimeType: string }).mimeType, detail: "high" });
	}
	return images;
}
