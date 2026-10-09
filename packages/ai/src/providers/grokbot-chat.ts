/** Explicit host-managed GrokBotService chat; never a fallback for named model inference. */
import { providerEntry } from "@oh-my-pi/pi-catalog/compat/providers";
import {
	createGrokbotRpcClient,
	GrokbotRpcError,
	type GrokbotRpcClient,
	type GrokbotRpcRecord,
} from "@oh-my-pi/pi-catalog/discovery/grokbot-rpc";
import { isRecord, prompt, readConnectFrames } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type { AssistantMessage, Context, Model, StreamFunction, StreamOptions, ToolChoice } from "../types";
import { normalizeSystemPrompts } from "../utils";
import { AssistantMessageEventStream } from "../utils/event-stream";
import historyPrompt from "./grokbot/chat-history.md" with { type: "text" };

const SERVICE = "/aiserver.v1.GrokBotService/";
const CHAT_TIMEOUT_MS = 300_000;

/** Only adapter-authored protocol diagnostics may reach the user without redacting transport exceptions. */
class GrokbotChatProtocolError extends Error {}

export interface GrokbotChatOptions extends StreamOptions {
	toolChoice?: ToolChoice;
	/** Bounds waiting for this one delivery; expiry never resubmits the prompt. */
	chatTimeoutMs?: number;
}

type ChatEntry = GrokbotRpcRecord;
interface ChatReply {
	text: string;
	entryId: string;
}
interface OwnedAgent {
	serverId: string;
	agentId: string;
	name: string;
}
interface ChatHistoryPart {
	text?: string;
	toolName?: string;
	arguments?: string;
}

function records(value: unknown): GrokbotRpcRecord[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

function bodyOf(entry: ChatEntry): GrokbotRpcRecord | undefined {
	if (typeof entry.body !== "string") return undefined;
	try {
		const body: unknown = JSON.parse(
			entry.body.startsWith("{") ? entry.body : Buffer.from(entry.body, "base64").toString("utf8"),
		);
		return isRecord(body) ? body : undefined;
	} catch {
		return undefined;
	}
}

function seqOf(entry: ChatEntry): bigint {
	const seq = entry.seq;
	if (typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0) return BigInt(seq);
	return typeof seq === "string" && /^\d+$/.test(seq) ? BigInt(seq) : 0n;
}

/** Only accept an assistant message newer than this request's own user nonce. */
export function grokbotChatReplyForNonce(entries: readonly ChatEntry[], nonce: string): ChatReply | undefined {
	const ordered = [...entries].sort((a, b) => (seqOf(a) > seqOf(b) ? -1 : seqOf(a) < seqOf(b) ? 1 : 0));
	const user = ordered.findIndex(entry => {
		const body = bodyOf(entry);
		return (
			body?.kind === "message" && body.role === "user" && (body.clientNonce === nonce || body.client_nonce === nonce)
		);
	});
	if (user < 0) return undefined;
	for (const entry of ordered.slice(0, user)) {
		const body = bodyOf(entry);
		if (!body || typeof entry.entryId !== "string") continue;
		const message = isRecord(body.message) ? body.message : undefined;
		if (body.kind === "send-message" && message?.type === "text" && typeof message.content === "string")
			return { text: message.content, entryId: entry.entryId };
		if (body.kind === "message" && body.role === "assistant" && typeof body.content === "string")
			return { text: body.content, entryId: entry.entryId };
	}
	return undefined;
}

export function grokbotChatPrompt(context: Context): string {
	const messages = context.messages.map(message => {
		const parts: ChatHistoryPart[] = [];
		if (typeof message.content === "string") parts.push({ text: message.content });
		else
			for (const part of message.content) {
				if (part.type === "image")
					throw new AIError.ConfigurationError(
						"Grok Bot host-managed chat accepts text only; use a native model route for images",
					);
				if (part.type === "text") parts.push({ text: part.text });
				if (part.type === "toolCall")
					parts.push({ toolName: part.name, arguments: JSON.stringify(part.arguments) });
				// Signed/native thinking has no verified lineage on this API and is omitted.
			}
		return { role: message.role, parts };
	});
	return prompt
		.render(historyPrompt, { systemPrompts: normalizeSystemPrompts(context.systemPrompt), messages })
		.trim();
}

function agentMatches(
	agent: GrokbotRpcRecord,
	agentId: string,
	name: string,
	originalIds: ReadonlySet<string>,
): boolean {
	return (
		agent.name === name &&
		(agent.agentId === agentId || agent.legacyAgentId === agentId) &&
		typeof agent.id === "string" &&
		!originalIds.has(agent.id) &&
		agent.viewerIsOwner === true &&
		agent.viewerCanManage === true
	);
}

async function collectReply(response: Response, agentId: string, nonce: string): Promise<ChatReply> {
	if (!response.ok) {
		const body: unknown = await response.json().catch(() => undefined);
		throw new GrokbotRpcError(response.status, isRecord(body) ? body.code : undefined);
	}
	if (!response.body || !response.headers.get("content-type")?.startsWith("application/connect+json"))
		throw new GrokbotChatProtocolError("Grok Bot transcript watch returned an invalid stream");
	const entries = new Map<string, ChatEntry>();
	for await (const frame of readConnectFrames(response.body)) {
		if (frame.flags & 1 || frame.flags & ~3)
			throw new GrokbotChatProtocolError("Grok Bot transcript watch returned unsupported envelope flags");
		const raw: unknown = frame.payload.length ? JSON.parse(frame.payload.toString("utf8")) : {};
		if (!isRecord(raw)) throw new GrokbotChatProtocolError("Grok Bot transcript watch returned an invalid frame");
		if (frame.flags & 2) {
			if (isRecord(raw.error)) throw new GrokbotRpcError(200, raw.error.code);
			break;
		}
		if (isRecord(raw.turnFailed) && raw.turnFailed.agentId === agentId)
			throw new GrokbotRpcError(200, raw.turnFailed.failureCode ?? "turn_failed");
		if (!isRecord(raw.rows)) continue;
		if (raw.rows.agentId !== agentId)
			throw new GrokbotChatProtocolError("Grok Bot transcript watch returned another agent");
		for (const entry of records(raw.rows.entries)) {
			const key = typeof entry.entryId === "string" ? entry.entryId : String(entry.seq);
			entries.set(key, entry);
		}
		const reply = grokbotChatReplyForNonce([...entries.values()], nonce);
		if (reply) return reply;
	}
	throw new GrokbotChatProtocolError("Grok Bot transcript watch ended without a reply to this request");
}

async function listAgents(client: GrokbotRpcClient, cleanup = false): Promise<GrokbotRpcRecord[]> {
	return records(
		(await client.rpc(`${SERVICE}ListGrokBotAgents`, {}, cleanup ? { signal: null, timeoutMs: 15_000 } : {})).agents,
	);
}

async function cleanupChatAgent(
	client: GrokbotRpcClient,
	agentId: string,
	name: string,
	originalIds: ReadonlySet<string>,
	owned: OwnedAgent | undefined,
): Promise<void> {
	const matches = (await listAgents(client, true)).filter(agent => agentMatches(agent, agentId, name, originalIds));
	if (matches.length > 1) throw new Error("Ambiguous temporary agent cleanup");
	if (matches.length === 1) {
		const target = matches[0]!;
		if (owned && target.id !== owned.serverId) throw new Error("Temporary agent identity changed");
		await client.rpc(`${SERVICE}DeleteGrokBotAgent`, { id: target.id }, { signal: null, timeoutMs: 15_000 });
	}
	const remaining = await listAgents(client, true);
	if (remaining.some(agent => agent.agentId === agentId || agent.legacyAgentId === agentId))
		throw new Error("Temporary agent still exists");
}

export const streamGrokbotChat: StreamFunction<"grokbot-chat"> = (
	model: Model<"grokbot-chat">,
	context: Context,
	options?: GrokbotChatOptions,
) => {
	const stream = new AssistantMessageEventStream();
	void (async () => {
		const began = performance.now();
		const hostManagedModel = providerEntry("grokbot-chat")!.defaultModel;
		const output: AssistantMessage = {
			role: "assistant",
			api: "grokbot-chat",
			provider: model.provider,
			model: hostManagedModel,
			content: [],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const lifetime = new AbortController();
		const signal = options?.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
		let client: GrokbotRpcClient | undefined;
		let originalIds = new Set<string>();
		const agentId = crypto.randomUUID();
		const name = `omp-chat-${agentId}`;
		let createAttempted = false;
		let owned: OwnedAgent | undefined;
		let watch: Promise<{ reply?: ChatReply; error?: unknown }> | undefined;
		let failure: unknown;
		let cleanupFailed = false;
		try {
			if (context.tools?.length && options?.toolChoice !== "none")
				throw new AIError.ConfigurationError(
					"Grok Bot host-managed chat cannot execute OMP tools; select --no-tools explicitly",
				);
			if (options?.toolChoice && options.toolChoice !== "none" && options.toolChoice !== "auto")
				throw new AIError.ConfigurationError("Grok Bot host-managed chat does not support forced tool choices");
			const text = grokbotChatPrompt(context);
			client = await createGrokbotRpcClient({
				apiKey: options?.apiKey,
				baseUrl: model.baseUrl,
				fetch: options?.fetch,
				headers: { ...model.headers, ...options?.headers },
				signal,
			});
			originalIds = new Set(
				(await listAgents(client)).flatMap(agent => (typeof agent.id === "string" ? [agent.id] : [])),
			);
			createAttempted = true;
			await client.rpc(`${SERVICE}CreateGrokBotAgent`, {
				legacyAgentId: agentId,
				agentId,
				name,
				title: name,
				description: "Temporary text-only OMP chat",
				avatarShape: "circle",
				avatarColor: "#6E56CF",
				harness: "TEMPORAL",
				kickstartRequested: false,
				introductionSuppressed: true,
				createIntent: "FRESH",
				purpose: "api",
				origin: "omp",
			});
			const matches = (await listAgents(client)).filter(agent => agentMatches(agent, agentId, name, originalIds));
			if (matches.length !== 1)
				throw new GrokbotChatProtocolError("Grok Bot chat could not verify its newly created agent");
			owned = { serverId: matches[0]!.id as string, agentId, name };
			const baseline = await client.rpc(`${SERVICE}ListGrokBotTranscriptEntries`, {
				agentId,
				limit: 40,
				sessionId: "",
			});
			if (records(baseline.entries).length)
				throw new GrokbotChatProtocolError("Grok Bot chat refused to attach to a nonempty transcript");
			const nonce = crypto.randomUUID();
			stream.push({ type: "start", partial: output });
			const response = await client.request(
				`${SERVICE}WatchGrokBotTranscripts`,
				{
					cursors: [{ agentId, generation: baseline.generation ?? 0, afterUpdatedSeq: "0" }],
					includeUnlistedAgents: false,
					inlineBodyMaxBytes: 262144,
				},
				{ stream: true, timeoutMs: options?.chatTimeoutMs ?? CHAT_TIMEOUT_MS },
			);
			watch = collectReply(response, agentId, nonce).then(
				reply => ({ reply }),
				error => ({ error }),
			);
			const sendPayload = {
				agentId,
				messageId: nonce,
				text,
				sentAtMs: String(Date.now()),
				isFork: false,
				source: "DESKTOP",
				sessionId: "",
				machineId: client.machineId,
			};
			// The CLI's normal hook returns an unchanged copy. Permit that and text
			// edits, but never let a hook redirect this turn or pretend to select a model.
			const observed = { ...sendPayload };
			const replacement = await options?.onPayload?.(observed, model);
			const candidate = replacement === undefined ? observed : replacement;
			if (
				!isRecord(candidate) ||
				Object.keys(candidate).some(key => !Object.hasOwn(sendPayload, key)) ||
				Object.entries(sendPayload).some(([key, value]) => key !== "text" && candidate[key] !== value) ||
				typeof candidate.text !== "string" ||
				!candidate.text.trim()
			) {
				throw new AIError.ConfigurationError(
					"Grok Bot chat onPayload permits only text edits, not routing, model, or tool overrides",
				);
			}
			const delivery = await client.rpc(`${SERVICE}SendGrokBotUserMessage`, {
				...sendPayload,
				text: candidate.text,
			});
			if (!String(delivery.delivery ?? "").includes("ACCEPTED") && delivery.dispatched !== true)
				throw new GrokbotChatProtocolError("Grok Bot chat refused this message delivery");
			const result = await watch;
			if (result.error) throw result.error;
			if (!result.reply?.text.trim()) throw new GrokbotChatProtocolError("Grok Bot chat returned no text reply");
			const readback = await client.rpc(`${SERVICE}ListGrokBotTranscriptEntries`, {
				agentId,
				limit: 40,
				sessionId: "",
			});
			const verified = grokbotChatReplyForNonce(records(readback.entries), nonce);
			if (!verified || verified.entryId !== result.reply.entryId || verified.text !== result.reply.text)
				throw new GrokbotChatProtocolError("Grok Bot chat reply failed independent transcript readback");
			output.content.push({ type: "text", text: verified.text });
			output.ttft = Math.round(performance.now() - began);
			stream.push({ type: "text_start", contentIndex: 0, partial: output });
			stream.push({ type: "text_delta", contentIndex: 0, delta: verified.text, partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: verified.text, partial: output });
		} catch (error) {
			failure = error;
		} finally {
			lifetime.abort();
			if (watch) await watch;
			if (client && createAttempted) {
				try {
					await cleanupChatAgent(client, agentId, name, originalIds, owned);
				} catch {
					cleanupFailed = true;
					failure = new AIError.ConfigurationError(
						`Grok Bot chat could not verify cleanup of temporary agent ${name}; check it in the official client`,
					);
				}
			}
		}
		output.duration = Math.round(performance.now() - began);
		if (failure !== undefined) {
			// Do not let a third-party transport's exception echo bearer headers.
			const safe =
				failure instanceof GrokbotRpcError ||
				failure instanceof GrokbotChatProtocolError ||
				failure instanceof AIError.ConfigurationError
					? failure
					: new Error(
							options?.signal?.aborted
								? "Grok Bot chat aborted"
								: "Grok Bot chat failed or did not return a verified reply",
						);
			const error = await AIError.finalize(safe, {
				api: model.api,
				provider: model.provider,
				model: hostManagedModel,
				signal: cleanupFailed ? undefined : options?.signal,
			});
			output.stopReason = error.stopReason;
			output.errorMessage = error.message;
			output.errorStatus = failure instanceof GrokbotRpcError ? failure.status : error.status;
			output.errorId = error.id;
			stream.push({ type: "error", reason: error.stopReason, error: output });
		} else {
			stream.push({ type: "done", reason: "stop", message: output });
		}
		stream.end(output);
	})();
	return stream;
};
