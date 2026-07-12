/**
 * Telegram collaboration bridge.
 *
 * Mirrors capture runs into a shared Telegram chat and routes replies back
 * into the same oh-my-pk session. Implements the transport-agnostic
 * CollaborationAdapter interface so Slack/Discord/Teams/web adapters can be
 * added later without touching the orchestrator.
 *
 * Inbound updates are accepted from either a webhook (validated with
 * X-Telegram-Bot-Api-Secret-Token) or a getUpdates long-poll loop; both paths
 * share durable update-id dedup, so redelivery and mixed modes are safe.
 */
import type { ImageContent } from "@pk-nerdsaver-ai/pi-ai";
import * as logger from "@pk-nerdsaver-ai/pi-utils/logger";

import type { TelegramCaptureConfig } from "./config";
import type { FollowUpInput, FollowUpResult } from "./orchestrator";
import { sanitizeForCollaboration } from "./redact";
import type { CaptureStore } from "./store";
import {
	type CaptureRun,
	type CaptureRunEvent,
	type CaptureRunStatus,
	type CollaborationAdapter,
	type CollaborationMessageRef,
	type CollaborationTurn,
	isTerminalRunStatus,
	type ParseResult,
	shortSessionLabel,
} from "./types";

/** The orchestrator surface the bridge dispatches into (kept narrow for tests). */
export interface CaptureDispatcher {
	followUp(runId: string, input: FollowUpInput): Promise<FollowUpResult>;
	cancel(runId: string, actor?: string): Promise<FollowUpResult>;
	submitTask(rawRequest: unknown): Promise<ParseResult<CaptureRun>>;
}

/** Narrow Bot API surface; the default implementation calls api.telegram.org. */
export interface TelegramTransport {
	call(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
	sendPhoto(
		payload: Record<string, unknown>,
		photo: { bytes: Uint8Array; mimeType: string },
		signal?: AbortSignal,
	): Promise<unknown>;
	downloadFile(filePath: string, signal?: AbortSignal): Promise<Uint8Array>;
}

/**
 * Per-request deadline. Must exceed the getUpdates long-poll window (25s) so a
 * healthy long-poll is never aborted by its own timeout.
 */
const TELEGRAM_REQUEST_TIMEOUT_MS = 60_000;

/** Combine an optional caller signal with a finite per-request deadline. */
function requestSignal(signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export class TelegramApiError extends Error {
	constructor(
		readonly method: string,
		message: string,
	) {
		super(`Telegram ${method} failed: ${message}`);
		this.name = "TelegramApiError";
	}
}

export function createTelegramTransport(botToken: string, fetchImpl: typeof fetch = fetch): TelegramTransport {
	const base = `https://api.telegram.org/bot${botToken}`;
	async function parse(method: string, response: Response): Promise<unknown> {
		const body = (await response.json().catch(() => undefined)) as
			| { ok?: boolean; result?: unknown; description?: string }
			| undefined;
		if (!body?.ok) throw new TelegramApiError(method, body?.description ?? `HTTP ${response.status}`);
		return body.result;
	}
	return {
		async call(method, payload, signal) {
			const response = await fetchImpl(`${base}/${method}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
				signal: requestSignal(signal),
			});
			return parse(method, response);
		},
		async sendPhoto(payload, photo, signal) {
			const form = new FormData();
			for (const [key, value] of Object.entries(payload)) {
				if (value !== undefined) form.set(key, String(value));
			}
			form.set(
				"photo",
				new Blob([photo.bytes.slice().buffer as ArrayBuffer], { type: photo.mimeType }),
				photo.mimeType === "image/jpeg" ? "capture.jpg" : "capture.png",
			);
			const response = await fetchImpl(`${base}/sendPhoto`, {
				method: "POST",
				body: form,
				signal: requestSignal(signal),
			});
			return parse("sendPhoto", response);
		},
		async downloadFile(filePath, signal) {
			const response = await fetchImpl(`https://api.telegram.org/file/bot${botToken}/${filePath}`, {
				signal: requestSignal(signal),
			});
			if (!response.ok) throw new TelegramApiError("downloadFile", `HTTP ${response.status}`);
			return new Uint8Array(await response.arrayBuffer());
		},
	};
}

interface TelegramUser {
	id: number;
	username?: string;
	first_name?: string;
}

interface TelegramMessage {
	message_id: number;
	chat: { id: number; type?: string };
	from?: TelegramUser;
	message_thread_id?: number;
	reply_to_message?: { message_id: number };
	text?: string;
	caption?: string;
	photo?: Array<{ file_id: string; width?: number; height?: number }>;
	document?: { file_id: string; mime_type?: string; file_name?: string };
}

interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
}

export type TelegramUpdateOutcome =
	| { kind: "duplicate" }
	| { kind: "ignored"; reason: string }
	| { kind: "unauthorized"; reason: string }
	| { kind: "command"; command: string }
	| { kind: "follow_up"; runId: string }
	| { kind: "error"; error: string };

const STATUS_LABELS: Record<CaptureRunStatus, string> = {
	queued: "Queued",
	starting: "Starting",
	running: "Running",
	waiting_for_user: "Waiting for user",
	completed: "Completed ✅",
	failed: "Failed ❌",
	cancelled: "Cancelled ⛔",
};

const HELP_TEXT = [
	"Capture agent commands:",
	"/status — show task and runner status",
	"/stop — cancel the active execution (session is kept)",
	"/resume — continue the mapped session",
	"/session — show the mapped session",
	"/runner — show the runner for this task",
	"/new <instruction> — start a new task+session in this thread",
	"/help — this message",
	"",
	"Reply to a task message to continue that task in the same agent session.",
].join("\n");

const MIN_EDIT_INTERVAL_MS = 2_000;
const MAX_TELEGRAM_TEXT = 3_900;

export interface TelegramBridgeOptions {
	config: TelegramCaptureConfig;
	store: CaptureStore;
	transport: TelegramTransport;
	now?: () => number;
}

interface RootMessageState {
	lastEditAt: number;
	lastText: string;
	activity?: string;
}

export class TelegramBridge implements CollaborationAdapter {
	readonly id = "telegram";
	readonly #config: TelegramCaptureConfig;
	readonly #store: CaptureStore;
	readonly #transport: TelegramTransport;
	readonly #now: () => number;
	readonly #rootState = new Map<string, RootMessageState>();
	#orchestrator: CaptureDispatcher | undefined;
	#pollAbort: AbortController | undefined;

	constructor(options: TelegramBridgeOptions) {
		this.#config = options.config;
		this.#store = options.store;
		this.#transport = options.transport;
		this.#now = options.now ?? (() => Date.now());
	}

	/** The orchestrator registers the bridge and the bridge dispatches into it. */
	bindOrchestrator(orchestrator: CaptureDispatcher): void {
		this.#orchestrator = orchestrator;
	}

	// ---------------------------------------------------------------- outbound

	async publishTask(
		run: CaptureRun,
		screenshot?: { bytes: Uint8Array; mimeType: string },
	): Promise<CollaborationMessageRef | undefined> {
		const chatId = run.telegramChatId ?? this.#config.defaultChatId;
		if (!chatId || run.telegramRootMessageId) return undefined;

		const text = this.#renderRootMessage(run);
		const payload: Record<string, unknown> = {
			chat_id: chatId,
			text,
			...(run.telegramTopicId !== undefined ? { message_thread_id: Number(run.telegramTopicId) } : {}),
		};
		const result = (await this.#transport.call("sendMessage", payload)) as { message_id?: number } | undefined;
		if (typeof result?.message_id !== "number") return undefined;
		const messageId = String(result.message_id);
		this.#rootState.set(run.id, { lastEditAt: this.#now(), lastText: text });

		if (screenshot) {
			try {
				const photo = (await this.#transport.sendPhoto(
					{
						chat_id: chatId,
						reply_to_message_id: result.message_id,
						...(run.telegramTopicId !== undefined ? { message_thread_id: Number(run.telegramTopicId) } : {}),
					},
					{ bytes: screenshot.bytes, mimeType: screenshot.mimeType },
				)) as { message_id?: number } | undefined;
				if (typeof photo?.message_id === "number") {
					this.#store.recordCollabMessage(
						this.id,
						chatId,
						String(photo.message_id),
						run.id,
						"reply",
						run.telegramTopicId,
					);
				}
			} catch (error) {
				// The preview is optional; the task message already stands on its own.
				logger.warn("Telegram screenshot preview failed", {
					runId: run.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		return {
			channelId: chatId,
			messageId,
			...(run.telegramTopicId !== undefined ? { topicId: run.telegramTopicId } : {}),
		};
	}

	async publishEvent(run: CaptureRun, event: CaptureRunEvent): Promise<void> {
		if (!run.telegramChatId || !run.telegramRootMessageId) return;
		switch (event.type) {
			case "run.status":
				await this.#editRoot(run, { force: isTerminalRunStatus(event.status) });
				return;
			case "run.tool": {
				const state = this.#rootState.get(run.id);
				if (state) state.activity = event.phase === "started" ? event.summary : `${event.summary}`;
				await this.#editRoot(run, {});
				return;
			}
			case "run.error":
				await this.#reply(run, `⚠️ ${sanitizeForCollaboration(event.error, 500)}`);
				return;
			case "run.follow_up":
				// Telegram-originated follow-ups are already visible in the chat.
				if (event.source !== "telegram") {
					await this.#reply(run, `↩️ Follow-up from ${event.participant ?? "the capture client"}: ${event.text}`);
				}
				return;
			default:
				return;
		}
	}

	async publishResult(run: CaptureRun, result: { status: CaptureRunStatus; text: string }): Promise<void> {
		if (!run.telegramChatId || !run.telegramRootMessageId) return;
		const state = this.#rootState.get(run.id);
		if (state) state.activity = undefined;
		const prefix = result.status === "completed" ? "✅" : result.status === "cancelled" ? "⛔" : "❌";
		await this.#reply(run, `${prefix} ${truncate(result.text, MAX_TELEGRAM_TEXT)}`);
	}

	async #reply(run: CaptureRun, text: string): Promise<void> {
		if (!run.telegramChatId) return;
		const result = (await this.#transport.call("sendMessage", {
			chat_id: run.telegramChatId,
			text: telegramText(text),
			...(run.telegramRootMessageId !== undefined ? { reply_to_message_id: Number(run.telegramRootMessageId) } : {}),
			...(run.telegramTopicId !== undefined ? { message_thread_id: Number(run.telegramTopicId) } : {}),
		})) as { message_id?: number } | undefined;
		if (typeof result?.message_id === "number") {
			this.#store.recordCollabMessage(
				this.id,
				run.telegramChatId,
				String(result.message_id),
				run.id,
				"reply",
				run.telegramTopicId,
			);
		}
	}

	async #editRoot(run: CaptureRun, options: { force?: boolean }): Promise<void> {
		if (!run.telegramChatId || !run.telegramRootMessageId) return;
		const state = this.#rootState.get(run.id) ?? { lastEditAt: 0, lastText: "" };
		this.#rootState.set(run.id, state);
		const text = this.#renderRootMessage(run, state.activity);
		if (text === state.lastText) return;
		const now = this.#now();
		if (!options.force && now - state.lastEditAt < MIN_EDIT_INTERVAL_MS) return;
		state.lastEditAt = now;
		state.lastText = text;
		try {
			await this.#transport.call("editMessageText", {
				chat_id: run.telegramChatId,
				message_id: Number(run.telegramRootMessageId),
				text,
			});
		} catch (error) {
			// "message is not modified" and transient failures are non-fatal.
			logger.debug("Telegram root edit failed", {
				runId: run.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		if (isTerminalRunStatus(run.status)) this.#rootState.delete(run.id);
	}

	#renderRootMessage(run: CaptureRun, activity?: string): string {
		const lines = [
			"🤖 New agent task",
			"",
			"Instruction:",
			truncate(sanitizeForCollaboration(run.instruction, 800), 800),
			"",
			`Runner: ${run.runnerId ?? "auto"}`,
			`Session: ${shortSessionLabel(run)}`,
			...(run.submittedBy ? [`Submitted by: ${run.submittedBy}`] : []),
			`Status: ${STATUS_LABELS[run.status]}`,
		];
		if (activity && !isTerminalRunStatus(run.status)) lines.push(`Activity: ${activity}`);
		// Sanitize the whole rendered payload: tool summaries and activity strings
		// pass through here without being individually redacted by callers.
		return telegramText(lines.join("\n"));
	}

	// ----------------------------------------------------------------- inbound

	/** Validate and process a webhook request. */
	async handleWebhookRequest(request: Request): Promise<Response> {
		// The webhook route is exempt from the gateway's loopback/origin checks, so a
		// configured secret is the only thing authenticating it. Refuse to serve the
		// route at all when no secret is set rather than trusting the request body.
		const secret = this.#config.webhookSecret;
		if (!secret) return new Response("Not found", { status: 404 });
		const provided = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
		if (!timingSafeEqualString(provided, secret)) {
			return new Response("Forbidden", { status: 403 });
		}
		let update: unknown;
		try {
			update = await request.json();
		} catch {
			return new Response("Invalid JSON", { status: 400 });
		}
		await this.handleUpdate(update);
		// Always 200: Telegram retries non-2xx, and our dedup already absorbed the update.
		return Response.json({ ok: true });
	}

	/** Long-poll getUpdates as an alternative to a publicly reachable webhook. */
	startLongPoll(): () => void {
		if (this.#pollAbort) return () => this.#pollAbort?.abort();
		const abort = new AbortController();
		this.#pollAbort = abort;
		void this.#pollLoop(abort.signal);
		return () => abort.abort();
	}

	async #pollLoop(signal: AbortSignal): Promise<void> {
		let offset = 0;
		while (!signal.aborted) {
			try {
				const updates = (await this.#transport.call(
					"getUpdates",
					{ offset, timeout: 25, allowed_updates: ["message"] },
					signal,
				)) as TelegramUpdate[] | undefined;
				for (const update of updates ?? []) {
					if (typeof update?.update_id === "number") offset = Math.max(offset, update.update_id + 1);
					await this.handleUpdate(update);
				}
			} catch (error) {
				if (signal.aborted) return;
				logger.warn("Telegram long-poll failed; retrying", {
					error: error instanceof Error ? error.message : String(error),
				});
				await Bun.sleep(3_000);
			}
		}
	}

	/** Process one Telegram update (webhook or poll). Idempotent by update_id. */
	async handleUpdate(input: unknown): Promise<TelegramUpdateOutcome> {
		const update = input as TelegramUpdate | undefined;
		if (!update || typeof update.update_id !== "number") {
			return { kind: "ignored", reason: "malformed update" };
		}
		if (!this.#store.claimTelegramUpdate(update.update_id)) return { kind: "duplicate" };

		const message = update.message;
		if (!message || typeof message.message_id !== "number" || !message.chat) {
			return { kind: "ignored", reason: "no message payload" };
		}
		const chatId = String(message.chat.id);
		const userId = message.from ? String(message.from.id) : undefined;

		if (!this.#config.allowedChatIds.has(chatId)) {
			this.#store.audit("telegram.unauthorized", { actor: userId, detail: `chat=${chatId}` });
			logger.warn("Telegram update from non-allowlisted chat ignored", { chatId });
			return { kind: "unauthorized", reason: "chat not allowlisted" };
		}
		if (this.#config.allowedUserIds.size > 0 && (!userId || !this.#config.allowedUserIds.has(userId))) {
			this.#store.audit("telegram.unauthorized", { actor: userId, detail: `chat=${chatId} user rejected` });
			await this.#send(chatId, message.message_thread_id, "You are not authorized to control this agent.");
			return { kind: "unauthorized", reason: "user not allowlisted" };
		}

		const text = (message.text ?? message.caption ?? "").trim();
		try {
			if (text.startsWith("/")) return await this.#handleCommand(message, chatId, text);
			return await this.#handleFollowUp(update.update_id, message, chatId, text);
		} catch (error) {
			const messageText = error instanceof Error ? error.message : String(error);
			logger.error("Telegram update handling failed", { chatId, error: messageText });
			return { kind: "error", error: messageText };
		}
	}

	async parseInboundMessage(input: unknown): Promise<CollaborationTurn | null> {
		const update = input as TelegramUpdate | undefined;
		const message = update?.message;
		if (!message?.chat) return null;
		const chatId = String(message.chat.id);
		const run = this.#resolveRun(message, chatId);
		if (!run) return null;
		const text = (message.text ?? message.caption ?? "").trim();
		if (!text) return null;
		return {
			runId: run.id,
			text,
			participant: displayName(message.from),
			source: "telegram",
		};
	}

	#resolveRun(message: TelegramMessage, chatId: string): CaptureRun | undefined {
		const topicId = message.message_thread_id !== undefined ? String(message.message_thread_id) : undefined;
		if (message.reply_to_message) {
			// An explicit reply targets exactly one message. If we don't recognize it,
			// do not silently hijack the latest run — a reply to an unrelated or expired
			// message must not continue the wrong agent session.
			const runId = this.#store.findRunIdByCollabMessage(
				this.id,
				chatId,
				String(message.reply_to_message.message_id),
			);
			return runId ? this.#store.getRun(runId) : undefined;
		}
		return this.#store.findLatestRunForChat(chatId, topicId);
	}

	async #handleCommand(message: TelegramMessage, chatId: string, text: string): Promise<TelegramUpdateOutcome> {
		const orchestrator = this.#orchestrator;
		const topicId = message.message_thread_id;
		const [rawCommand, ...rest] = text.split(/\s+/);
		const command = (rawCommand ?? "/help").split("@")[0]?.toLowerCase() ?? "/help";
		const args = rest.join(" ").trim();
		const actor = displayName(message.from);
		const run = this.#resolveRun(message, chatId);

		const respond = (body: string) => this.#send(chatId, topicId, body);

		switch (command) {
			case "/help":
				await respond(HELP_TEXT);
				return { kind: "command", command };
			case "/status": {
				if (!run) {
					await respond("No capture task is mapped to this thread yet.");
					return { kind: "command", command };
				}
				const runnerStatus = orchestrator ? "" : " (orchestrator offline)";
				await respond(
					[
						`Task: ${truncate(run.instruction, 200)}`,
						`Session: ${shortSessionLabel(run)}`,
						`Runner: ${run.runnerId ?? "auto"}${runnerStatus}`,
						`Status: ${STATUS_LABELS[run.status]}`,
						...(run.error ? [`Error: ${sanitizeForCollaboration(run.error, 300)}`] : []),
					].join("\n"),
				);
				return { kind: "command", command };
			}
			case "/session": {
				if (!run) {
					await respond("No capture task is mapped to this thread yet.");
					return { kind: "command", command };
				}
				await respond(
					[`Session: ${shortSessionLabel(run)}`, ...(run.sessionId ? [`Session id: ${run.sessionId}`] : [])].join(
						"\n",
					),
				);
				return { kind: "command", command };
			}
			case "/runner": {
				if (!run) {
					await respond("No capture task is mapped to this thread yet.");
					return { kind: "command", command };
				}
				await respond(`Runner: ${run.runnerId ?? "auto"} (runner reassignment is not supported yet)`);
				return { kind: "command", command };
			}
			case "/stop": {
				if (!run || !orchestrator) {
					await respond("Nothing to stop here.");
					return { kind: "command", command };
				}
				const result = await orchestrator.cancel(run.id, actor);
				await respond(
					result.accepted
						? "Cancelled the active execution. The session is preserved."
						: (result.reason ?? "Could not cancel."),
				);
				return { kind: "command", command };
			}
			case "/resume": {
				if (!run || !orchestrator) {
					await respond("Nothing to resume here.");
					return { kind: "command", command };
				}
				const result = await orchestrator.followUp(run.id, {
					text: args || "Continue working on the task from where you left off.",
					source: "telegram",
					participant: actor,
				});
				await respond(result.accepted ? "Resuming the session…" : (result.reason ?? "Could not resume."));
				return { kind: "command", command };
			}
			case "/new": {
				if (!orchestrator) {
					await respond("The capture orchestrator is not available.");
					return { kind: "command", command };
				}
				if (!args) {
					await respond("Usage: /new <instruction>");
					return { kind: "command", command };
				}
				const submitted = await orchestrator.submitTask({
					requestId: `telegram-${chatId}-${message.message_id}`,
					source: { type: "selected-text", capturedAt: new Date().toISOString() },
					instruction: args,
					routing: {},
					collaboration: {
						telegramChatId: chatId,
						...(topicId !== undefined ? { telegramTopicId: String(topicId) } : {}),
					},
					...(actor !== undefined ? { submittedBy: actor } : {}),
				});
				if (!submitted.ok) await respond(`Could not start a new task: ${submitted.error}`);
				return { kind: "command", command };
			}
			default:
				await respond(`Unknown command ${command}. ${HELP_TEXT}`);
				return { kind: "command", command };
		}
	}

	async #handleFollowUp(
		updateId: number,
		message: TelegramMessage,
		chatId: string,
		text: string,
	): Promise<TelegramUpdateOutcome> {
		const orchestrator = this.#orchestrator;
		if (!orchestrator) return { kind: "ignored", reason: "orchestrator not bound" };
		const run = this.#resolveRun(message, chatId);
		if (!run) return { kind: "ignored", reason: "no mapped run for this thread" };

		const images = await this.#collectImages(message);
		if (!text && images.length === 0) return { kind: "ignored", reason: "empty message" };

		const result = await orchestrator.followUp(run.id, {
			text: text || "Please look at the attached image(s).",
			...(images.length > 0 ? { images } : {}),
			source: "telegram",
			participant: displayName(message.from),
			idempotencyKey: `telegram:${updateId}`,
		});
		if (!result.accepted) {
			await this.#send(chatId, message.message_thread_id, result.reason ?? "Could not continue this task.");
			return { kind: "error", error: result.reason ?? "follow-up rejected" };
		}
		return { kind: "follow_up", runId: run.id };
	}

	async #collectImages(message: TelegramMessage): Promise<ImageContent[]> {
		const images: ImageContent[] = [];
		const fileIds: Array<{ fileId: string; mimeType: string }> = [];
		if (message.photo && message.photo.length > 0) {
			// Telegram sends multiple sizes; take the largest (last).
			const largest = message.photo[message.photo.length - 1];
			if (largest?.file_id) fileIds.push({ fileId: largest.file_id, mimeType: "image/jpeg" });
		}
		if (
			message.document?.file_id &&
			(message.document.mime_type === "image/png" || message.document.mime_type === "image/jpeg")
		) {
			// Only forward supported types with their true MIME; a GIF/WebP mislabeled
			// as JPEG would fail to decode downstream.
			fileIds.push({ fileId: message.document.file_id, mimeType: message.document.mime_type });
		}
		for (const { fileId, mimeType } of fileIds) {
			try {
				const info = (await this.#transport.call("getFile", { file_id: fileId })) as
					| { file_path?: string }
					| undefined;
				if (!info?.file_path) continue;
				const bytes = await this.#transport.downloadFile(info.file_path);
				images.push({ type: "image", data: bytes.toBase64(), mimeType, detail: "high" });
			} catch (error) {
				logger.warn("Failed to download Telegram attachment", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return images;
	}

	async #send(chatId: string, topicId: number | undefined, text: string): Promise<void> {
		try {
			await this.#transport.call("sendMessage", {
				chat_id: chatId,
				text: telegramText(text),
				...(topicId !== undefined ? { message_thread_id: topicId } : {}),
			});
		} catch (error) {
			logger.warn("Telegram send failed", { error: error instanceof Error ? error.message : String(error) });
		}
	}
}

/** Single outbound-text boundary: redact credentials, then bound to Telegram's limit. */
function telegramText(text: string): string {
	return truncate(sanitizeForCollaboration(text, MAX_TELEGRAM_TEXT), MAX_TELEGRAM_TEXT);
}

function displayName(user: TelegramUser | undefined): string | undefined {
	if (!user) return undefined;
	return user.username ? `@${user.username}` : (user.first_name ?? String(user.id));
}

function truncate(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

/** Constant-time-ish comparison to avoid trivially timing the webhook secret. */
export function timingSafeEqualString(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const bytesA = encoder.encode(a);
	const bytesB = encoder.encode(b);
	let mismatch = bytesA.length === bytesB.length ? 0 : 1;
	const length = Math.max(bytesA.length, bytesB.length);
	for (let i = 0; i < length; i++) {
		mismatch |= (bytesA[i % bytesA.length] ?? 0) ^ (bytesB[i % bytesB.length] ?? 0);
	}
	return mismatch === 0;
}
