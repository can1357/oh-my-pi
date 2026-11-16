/**
 * One stateful agy ACP conversation across omp's per-step stream calls.
 * MCP tool calls park between steps. A deadline cancels and drains the ACP
 * prompt before releasing its MCP response; the actual late result is sent
 * only in a subsequent prompt. Failed drains kill the process and reseed.
 */
import * as path from "node:path";
import { $which, isRecord, logger, stableStringifyJson } from "@oh-my-pi/pi-utils";
import {
	type ContentBlock,
	ClientSideConnection,
	ndJsonStream,
	type PromptResponse,
	RequestError,
	type SessionConfigOption,
	type SessionNotification,
} from "@oh-my-pi/pi-utils/acp";
import type {
	AntigravityCliCheckpoint,
	Context,
	Message,
	Model,
	ProviderSessionState,
	Tool,
	ToolResultMessage,
} from "../../types";
import { normalizeSchemaForCCA, toolWireSchema } from "../../utils/schema";
import { validateJsonSchemaValue } from "../../utils/schema/json-schema-validator";
import agentDefinition from "./agent.md" with { type: "text" };
import { resolveAgyBinary } from "./binary";
import {
	conversationStorePath,
	deleteConversation,
	forkConversation,
	readConversationCheckpoint,
} from "./conversation-store";
import { agyCredentialEnv } from "./credentials";
import { type McpCallHandler, McpBridge, type McpToolDefinition, type McpToolOutput } from "./mcp-bridge";
import { inputBlocks, type Ledger, lateToolResultPrompt, planTurn, replayPrompt, transcriptDigest } from "./reconcile";
import type { StepWriter } from "./step-writer";

const AGENT_NAME = "bridge";
const STARTUP_TIMEOUT_MS = 60_000;
const ANNOUNCEMENT_TIMEOUT_MS = 2_000;
// Leave enough time to force-stop a process that never acknowledges cancellation.
const HOLD_LIMIT_MS = 165_000;
const CANCEL_TIMEOUT_MS = 5_000;
const MCP_TOOL_NAME = /\bmcp_ide-tools_(\S+)/;

/** Per-step request settings. */
export interface AgyStepOptions {
	cwd?: string;
	reasoning?: string;
	signal?: AbortSignal;
	/** Non-secret credential revision; a changed revision restarts agy's native token cache. */
	credentialVersion?: string;
}

/** ACP operations required by the host; injectable without module or environment mutation. */
export type AgyConnection = Pick<
	ClientSideConnection,
	| "initialize"
	| "newSession"
	| "loadSession"
	| "closeSession"
	| "setSessionConfigOption"
	| "prompt"
	| "cancel"
	| "signal"
>;

/** Owned process/connection resources. close must terminate the transport and is idempotent. */
export interface AgyTransport {
	connection: AgyConnection;
	exited: Promise<number>;
	close(): void;
}

/** Arguments for the production transport or an isolated test transport. */
export interface AgyTransportOptions {
	geminiDir: string;
	cwd: string;
	tools: readonly McpToolDefinition[];
	signal: AbortSignal;
	onCall: McpCallHandler;
	onUpdate(notification: SessionNotification): void;
}

/** A scheduled host deadline; cancellation must be idempotent. */
export interface AgyTimer {
	cancel(): void;
}

/** Clock seam keeps lifecycle tests isolated from global timers. */
export type AgyScheduler = (delayMs: number, callback: () => void) => AgyTimer;

/** Dependency seam for deterministic ACP lifecycle tests, not an alternative inference API. */
export interface AgyHostOptions {
	startTransport?: (options: AgyTransportOptions) => Promise<AgyTransport>;
	holdLimitMs?: number;
	cancelTimeoutMs?: number;
	announcementTimeoutMs?: number;
	startupTimeoutMs?: number;
	schedule?: AgyScheduler;
}

interface AgyProcess extends AgyTransport {
	token: object;
	toolsKey: string;
	credentialVersion?: string;
	tools: ReadonlyMap<string, McpToolDefinition>;
	cwd: string;
	onClosed(): void;
}

interface Conversation {
	id: string;
	systemKey: string;
	loaded: boolean;
	model?: string;
	effort?: string;
	defaultEffort?: string;
	requestedEffort?: string;
}

interface ActiveStep {
	writer: StepWriter;
	messages: readonly Message[];
	done: PromiseWithResolvers<void>;
	interrupted: PromiseWithResolvers<never>;
	controller: AbortController;
	aborted: boolean;
}

interface PendingCall {
	id: string;
	state: "parked" | "cancelling" | "detached";
	settle(output: McpToolOutput): void;
	expiry: AgyTimer;
	drain?: Promise<void>;
}

interface Turn {
	conversationId: string;
	response: PromiseWithResolvers<PromptResponse>;
	stopped: PromiseWithResolvers<never>;
	cancelling: boolean;
	cancellation?: Promise<void>;
}

/** Owns one ACP process and its live ledger; callers must retain it between tool steps. */
export class AgyHost implements ProviderSessionState {
	readonly #geminiDir: string;
	readonly #options: Required<AgyHostOptions>;
	readonly #ownedConversations = new Set<string>();
	readonly #exits = new Set<Promise<number>>();
	#process: AgyProcess | undefined;
	#conversation: Conversation | undefined;
	#ledger: Ledger | undefined;
	#pending: PendingCall | undefined;
	#step: ActiveStep | undefined;
	#turn: Turn | undefined;
	readonly #turns = new Set<Turn>();
	#loading: object | undefined;
	#contextTokens = 0;
	#announced = new Map<string, number>();
	#announcementWaiters = new Set<{ name: string; finish(announced: boolean): void }>();

	/** geminiDir is the account-scoped agy configuration and conversation directory. */
	constructor(geminiDir: string, options: AgyHostOptions = {}) {
		this.#geminiDir = geminiDir;
		this.#options = {
			startTransport: options.startTransport ?? startTransport,
			holdLimitMs: options.holdLimitMs ?? HOLD_LIMIT_MS,
			cancelTimeoutMs: options.cancelTimeoutMs ?? CANCEL_TIMEOUT_MS,
			announcementTimeoutMs: options.announcementTimeoutMs ?? ANNOUNCEMENT_TIMEOUT_MS,
			startupTimeoutMs: options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
			schedule: options.schedule ?? scheduleTimer,
		};
		if (
			this.#options.holdLimitMs <= 0 ||
			this.#options.cancelTimeoutMs <= 0 ||
			this.#options.holdLimitMs + this.#options.cancelTimeoutMs >= 180_000
		) {
			throw new Error("Antigravity CLI cancellation must finish before its 180s MCP deadline");
		}
	}

	/** Stable identity for retaining a host when a caller omitted providerSessionState. */
	get conversationId(): string | undefined {
		return this.#conversation?.id;
	}

	/** True while inference or an unresolved tool result still belongs to this host. */
	get hasPendingTurn(): boolean {
		return this.#turn !== undefined || this.#pending !== undefined || this.#step !== undefined;
	}

	/** Emit one assistant step, parking at a tool call or finishing at the ACP turn end. */
	async step(model: Model, context: Context, options: AgyStepOptions, writer: StepWriter): Promise<void> {
		if (this.#step) throw new Error("Antigravity CLI is already running a request for this session");
		const step: ActiveStep = {
			writer,
			messages: context.messages,
			done: Promise.withResolvers<void>(),
			interrupted: Promise.withResolvers<never>(),
			controller: new AbortController(),
			aborted: false,
		};
		step.done.promise.catch(() => undefined);
		step.interrupted.promise.catch(() => undefined);
		this.#step = step;
		const onAbort = () => {
			step.aborted = true;
			this.#fail(new Error("Request was aborted"));
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			if (options.signal?.aborted) onAbort();
			step.controller.signal.throwIfAborted();
			const cwd = options.cwd ?? process.cwd();
			const tools = (context.tools ?? []).map(toMcpTool);
			const toolsKey = stableStringifyJson(tools);
			const system = (context.systemPrompt ?? []).join("\n\n");
			const systemKey = system;
			let plan = planTurn(context.messages, this.#ledger);
			const parkedTurnMoves =
				this.#pending?.state !== "detached" &&
				this.#pending !== undefined &&
				(this.#process?.toolsKey !== toolsKey ||
					this.#process.cwd !== cwd ||
					this.#process.credentialVersion !== options.credentialVersion ||
					this.#conversation?.systemKey !== systemKey ||
					this.#conversation.model !== model.id ||
					this.#conversation.requestedEffort !== options.reasoning);
			if (
				plan.kind === "resume" &&
				(!this.#conversation || parkedTurnMoves || (plan.toolResult && !this.#pending))
			) {
				plan = planTurn(context.messages, undefined);
			}
			if (plan.kind !== "resume") await this.#setup(this.#abandonTurn());
			if (
				this.#process?.toolsKey !== toolsKey ||
				this.#process.cwd !== cwd ||
				this.#process.credentialVersion !== options.credentialVersion
			) {
				await this.#startProcess(tools, toolsKey, cwd, step, options.credentialVersion);
			}
			let loadId: string | undefined;
			if (plan.kind === "resume") {
				const conversation = this.#conversation;
				if (!conversation) throw new Error("Antigravity CLI conversation was lost");
				if (!conversation.loaded || conversation.systemKey !== systemKey) loadId = conversation.id;
			} else if (plan.kind === "restore") {
				let forkId: string | undefined;
				try {
					forkId = forkConversation(this.#geminiDir, plan.conversationId, plan.checkpoint, plan.digest);
				} catch {
					logger.debug("Antigravity CLI checkpoint unavailable; replaying the supplied transcript");
				}
				if (forkId) {
					this.#ownedConversations.add(forkId);
					loadId = forkId;
				} else plan = { kind: "fresh", replay: [...context.messages] };
			}
			if (loadId) {
				try {
					await this.#setup(this.#loadConversation(loadId, system, systemKey, cwd));
				} catch (error) {
					if (step.controller.signal.aborted) throw error;
					// A store can outlive an incompatible native CLI version. Do not reuse a partial load.
					this.#stopProcess();
					await this.#startProcess(tools, toolsKey, cwd, step, options.credentialVersion);
					plan = { kind: "fresh", replay: [...context.messages] };
				}
			}
			if (plan.kind === "fresh") {
				await this.#setup(this.#unloadConversation());
				const created = await this.#setup(
					this.#requireProcess().connection.newSession({ cwd, mcpServers: [], _meta: systemMeta(system) }),
				);
				conversationStorePath(this.#geminiDir, created.sessionId);
				this.#ownedConversations.add(created.sessionId);
				this.#conversation = {
					id: created.sessionId,
					systemKey,
					loaded: true,
					defaultEffort: thoughtLevel(created.configOptions),
				};
				this.#contextTokens = 0;
			}
			await this.#setup(this.#configure(model.id, options.reasoning));
			step.controller.signal.throwIfAborted();
			if (plan.kind === "resume") {
				const pending = this.#pending;
				if (pending?.drain) await this.#setup(pending.drain);
				if (plan.toolResult && pending?.state === "detached") {
					this.#releasePending();
					this.#prompt([...lateToolResultPrompt(plan.toolResult), ...plan.input.flatMap(inputBlocks)]);
				} else {
					pending?.expiry.cancel();
					if (plan.input.length > 0) {
						const previous = this.#turn;
						this.#prompt(plan.input.flatMap(inputBlocks));
						// The old prompt settling proves agy accepted the steer before the held tool resumes.
						if (previous)
							await this.#setup(
								withTimeout(
									previous.response.promise,
									this.#options.cancelTimeoutMs,
									"Antigravity CLI did not accept steering",
									this.#options.schedule,
								),
							);
					}
					if (pending?.drain) await this.#setup(pending.drain);
					if (plan.toolResult) {
						if (this.#pending !== pending || !pending || pending.state !== "parked")
							throw new Error("Antigravity CLI tool continuation was interrupted");
						this.#releasePending()?.settle(toMcpOutput(plan.toolResult));
					}
				}
			} else {
				const blocks = replayPrompt(plan.replay);
				if (blocks.length === 0) throw new Error("Antigravity CLI has nothing new to send for this request");
				this.#prompt(blocks);
			}
			await step.done.promise;
		} catch (error) {
			this.#fail(error);
			throw step.aborted ? new Error("Request was aborted") : mapAgyError(error);
		} finally {
			options.signal?.removeEventListener("abort", onAbort);
			if (this.#step === step) this.#step = undefined;
		}
	}

	/** Immediately stop all work and settle promises/timers; retained disk history can still be forked. */
	close(): void {
		this.#fail(new Error("Antigravity CLI session closed"));
		this.#conversation = undefined;
	}

	/** Stop first, await process exit, then remove only conversations this host created (never fork sources). */
	async dispose(): Promise<void> {
		this.close();
		await withTimeout(
			Promise.all(this.#exits),
			this.#options.cancelTimeoutMs,
			"Antigravity CLI did not exit",
			this.#options.schedule,
		);
		await Promise.all([...this.#ownedConversations].map(id => deleteConversation(this.#geminiDir, id)));
		this.#ownedConversations.clear();
	}

	async #setup<T>(operation: Promise<T>): Promise<T> {
		const step = this.#step;
		if (!step) throw new Error("Antigravity CLI request ended during setup");
		return withTimeout(
			Promise.race([operation, step.interrupted.promise]),
			this.#options.startupTimeoutMs,
			"Antigravity CLI setup timed out",
			this.#options.schedule,
		);
	}

	#requireProcess(): AgyProcess {
		if (!this.#process) throw new Error("Antigravity CLI process is unavailable");
		return this.#process;
	}

	async #startProcess(
		tools: McpToolDefinition[],
		toolsKey: string,
		cwd: string,
		step: ActiveStep,
		credentialVersion: string | undefined,
	): Promise<void> {
		const detached = this.#pending?.state === "detached" ? this.#pending : undefined;
		const ledger = this.#ledger;
		this.#stopProcess();
		if (detached) {
			this.#pending = detached;
			this.#ledger = ledger;
		}
		const token = {};
		const starting = this.#options.startTransport({
			geminiDir: this.#geminiDir,
			cwd,
			tools,
			signal: step.controller.signal,
			onCall: async (name, args, id) => {
				try {
					return await this.#onToolCall(token, name, args, id);
				} catch (error) {
					if (this.#process?.token === token) this.#fail(error);
					return errorOutput("Tool transport failed; the turn was stopped.");
				}
			},
			onUpdate: update => {
				if (this.#process?.token !== token) return;
				try {
					this.#onUpdate(update);
				} catch (error) {
					this.#fail(error);
				}
			},
		});
		void starting.then(
			transport => {
				if (step.controller.signal.aborted) transport.close();
			},
			() => undefined,
		);
		const transport = await this.#setup(starting);
		const agy: AgyProcess = {
			connection: transport.connection,
			exited: transport.exited,
			close: () => transport.close(),
			token,
			toolsKey,
			credentialVersion,
			tools: new Map(tools.map(tool => [tool.name, tool])),
			cwd,
			onClosed: () => {
				if (this.#process === agy) this.#fail(new Error("Antigravity CLI ACP connection closed"));
			},
		};
		this.#process = agy;
		this.#exits.add(transport.exited);
		void transport.exited.then(
			code => {
				this.#exits.delete(transport.exited);
				if (this.#process === agy) this.#fail(new Error(`Antigravity CLI exited with code ${code}`));
			},
			() => {
				if (this.#process === agy) this.#fail(new Error("Antigravity CLI process exit failed"));
			},
		);
		agy.connection.signal.addEventListener("abort", agy.onClosed, { once: true });
		if (agy.connection.signal.aborted) agy.onClosed();
		await this.#setup(
			agy.connection.initialize({
				protocolVersion: 1,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
				clientInfo: { name: "bridge", title: "Host tool bridge", version: "1" },
			}),
		);
	}

	#stopProcess(): void {
		const agy = this.#process;
		this.#process = undefined;
		if (this.#turn || this.#pending) this.#ledger = undefined;
		this.#turn?.stopped.reject(new Error("Antigravity CLI turn stopped"));
		this.#turn = undefined;
		for (const turn of this.#turns) {
			const error = new Error("Antigravity CLI turn stopped");
			turn.stopped.reject(error);
			turn.response.reject(error);
		}
		this.#turns.clear();
		this.#releasePending()?.settle(errorOutput("Tool call cancelled: the host stopped this turn."));
		for (const waiter of this.#announcementWaiters) waiter.finish(false);
		this.#announced.clear();
		if (this.#conversation) this.#conversation.loaded = false;
		if (agy) {
			agy.connection.signal.removeEventListener("abort", agy.onClosed);
			agy.close();
		}
	}

	async #unloadConversation(): Promise<void> {
		const conversation = this.#conversation;
		if (conversation?.loaded) {
			await this.#requireProcess().connection.closeSession({ sessionId: conversation.id });
			conversation.loaded = false;
		}
	}

	async #loadConversation(id: string, system: string, systemKey: string, cwd: string): Promise<void> {
		conversationStorePath(this.#geminiDir, id);
		const agy = this.#requireProcess();
		await this.#unloadConversation();
		const loading = {};
		this.#loading = loading;
		try {
			const step = this.#step;
			const loaded = await agy.connection.loadSession({
				sessionId: id,
				cwd,
				mcpServers: [],
				_meta: systemMeta(system),
			});
			if (this.#process !== agy || step !== this.#step || step?.controller.signal.aborted)
				throw new Error("Antigravity CLI load was interrupted");
			this.#conversation = { id, systemKey, loaded: true, defaultEffort: thoughtLevel(loaded.configOptions) };
			this.#contextTokens = 0;
		} finally {
			if (this.#loading === loading) this.#loading = undefined;
		}
	}

	async #configure(modelId: string, effort: string | undefined): Promise<void> {
		const conversation = this.#conversation;
		if (!conversation) throw new Error("Antigravity CLI conversation is unavailable");
		const connection = this.#requireProcess().connection;
		if (conversation.model !== modelId) {
			const response = await connection.setSessionConfigOption({
				sessionId: conversation.id,
				configId: "model",
				value: modelId,
			});
			conversation.model = modelId;
			conversation.defaultEffort = thoughtLevel(response.configOptions) ?? conversation.defaultEffort;
			conversation.effort = thoughtLevel(response.configOptions);
		}
		const desired = effort ?? conversation.defaultEffort;
		if (desired && conversation.effort !== desired) {
			await connection.setSessionConfigOption({
				sessionId: conversation.id,
				configId: "thought_level",
				value: desired,
			});
			conversation.effort = desired;
		}
		conversation.requestedEffort = effort;
	}

	#prompt(blocks: ContentBlock[]): void {
		const conversation = this.#conversation;
		if (!conversation) throw new Error("Antigravity CLI conversation is unavailable");
		const turn: Turn = {
			conversationId: conversation.id,
			response: Promise.withResolvers<PromptResponse>(),
			stopped: Promise.withResolvers<never>(),
			cancelling: false,
		};
		turn.stopped.promise.catch(() => undefined);
		this.#turn = turn;
		this.#turns.add(turn);
		void turn.response.promise
			.then(
				response => {
					this.#turns.delete(turn);
					this.#turnEnded(turn, response);
				},
				error => {
					this.#turns.delete(turn);
					if (this.#turn === turn && !turn.cancelling) this.#fail(error);
				},
			)
			.catch(error => this.#fail(error));
		try {
			void this.#requireProcess()
				.connection.prompt({ sessionId: conversation.id, prompt: blocks })
				.then(turn.response.resolve, turn.response.reject);
		} catch (error) {
			turn.response.reject(error);
		}
	}

	#releasePending(): PendingCall | undefined {
		const pending = this.#pending;
		this.#pending = undefined;
		pending?.expiry.cancel();
		return pending;
	}

	#detach(pending: PendingCall): void {
		if (this.#pending !== pending || pending.state !== "parked") return;
		pending.state = "cancelling";
		pending.drain = this.#cancelTurn().then(() => {
			if (this.#pending !== pending)
				throw new Error("Antigravity CLI tool call was interrupted during cancellation");
			pending.state = "detached";
			pending.settle(
				errorOutput(
					"Tool transport cancelled while the host continues execution; the actual result will follow in a new turn.",
				),
			);
		});
		void pending.drain.catch(error => this.#fail(error));
	}

	/** cancel() writes a notification; only the outstanding prompt's cancelled response acknowledges it. */
	#cancelTurn(): Promise<void> {
		const turn = this.#turn;
		if (!turn) return Promise.resolve();
		if (turn.cancellation) return turn.cancellation;
		turn.cancelling = true;
		turn.cancellation = (async () => {
			const connection = this.#requireProcess().connection;
			const [, response] = await withTimeout(
				Promise.race([
					Promise.all([connection.cancel({ sessionId: turn.conversationId }), turn.response.promise]),
					turn.stopped.promise,
				]),
				this.#options.cancelTimeoutMs,
				"Antigravity CLI did not confirm cancellation",
				this.#options.schedule,
			);
			if (response.stopReason !== "cancelled" || this.#turn !== turn)
				throw new Error("Antigravity CLI cancellation was not acknowledged");
			this.#turn = undefined;
			this.#announced.clear();
		})();
		return turn.cancellation;
	}

	async #abandonTurn(): Promise<void> {
		this.#ledger = undefined;
		this.#pending?.expiry.cancel();
		try {
			if (this.#pending?.drain) await this.#pending.drain;
			await this.#cancelTurn();
			this.#releasePending()?.settle(errorOutput("Tool call cancelled: the supplied conversation changed."));
		} catch {
			// A dead or unresponsive process cannot safely continue; the supplied transcript can.
			this.#stopProcess();
		}
	}

	async #onToolCall(
		token: object,
		name: string,
		args: Record<string, unknown>,
		callerId: string | undefined,
	): Promise<McpToolOutput> {
		const agy = this.#process;
		if (!agy || agy.token !== token) return errorOutput("Tool call belongs to a stopped process.");
		const tool = agy.tools.get(name);
		if (!tool || !validateJsonSchemaValue(tool.inputSchema, args).success) {
			this.#fail(new Error("Antigravity CLI requested an unknown tool or invalid arguments"));
			return errorOutput("Unknown tool or invalid arguments; no execution occurred.");
		}
		const announced = await this.#awaitAnnouncement(name);
		const step = this.#step;
		const conversationId = this.#conversation?.id;
		if (
			!announced ||
			this.#process !== agy ||
			!step ||
			step.writer.done ||
			step.aborted ||
			!conversationId ||
			(callerId !== undefined && callerId !== conversationId) ||
			this.#pending ||
			!this.#turn ||
			this.#turn.cancelling
		) {
			if (this.#process === agy) this.#fail(new Error("Antigravity CLI requested a tool outside the active step"));
			return errorOutput("Tool call rejected; no execution occurred.");
		}
		const id = `agy_${crypto.randomUUID().replaceAll("-", "")}`;
		const result = Promise.withResolvers<McpToolOutput>();
		const pending: PendingCall = {
			id,
			state: "parked",
			settle: result.resolve,
			expiry: this.#options.schedule(this.#options.holdLimitMs, () => this.#detach(pending)),
		};
		this.#pending = pending;
		step.writer.toolCall({ type: "toolCall", id, name, arguments: args });
		step.writer.usage(this.#contextTokens);
		const digest = transcriptDigest([...step.messages, step.writer.output]);
		step.writer.finish("toolUse", { type: "antigravityCli", conversationId, digest });
		this.#ledger = { count: step.messages.length + 1, digest, pendingToolCallId: id };
		step.done.resolve();
		return result.promise;
	}

	#awaitAnnouncement(name: string): Promise<boolean> {
		const count = this.#announced.get(name) ?? 0;
		if (count > 0) {
			this.#announced.set(name, count - 1);
			return Promise.resolve(true);
		}
		const result = Promise.withResolvers<boolean>();
		const waiter = {
			name,
			finish: (announced: boolean) => {
				timer.cancel();
				this.#announcementWaiters.delete(waiter);
				result.resolve(announced);
			},
		};
		const timer = this.#options.schedule(this.#options.announcementTimeoutMs, () => waiter.finish(false));
		this.#announcementWaiters.add(waiter);
		return result.promise;
	}

	#onUpdate(notification: SessionNotification): void {
		if (this.#loading || !this.#turn || notification.sessionId !== this.#conversation?.id || this.#turn.cancelling)
			return;
		const update = notification.update;
		const writer = this.#step?.aborted ? undefined : this.#step?.writer;
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
				if (update.content.type === "text") writer?.text(update.content.text);
				return;
			case "agent_thought_chunk":
				if (update.content.type === "text") writer?.thinking(update.content.text);
				return;
			case "usage_update":
				this.#contextTokens = update.used;
				return;
			case "tool_call": {
				const name = MCP_TOOL_NAME.exec(update.title)?.[1];
				if (!name) return;
				const waiter = [...this.#announcementWaiters].find(candidate => candidate.name === name);
				if (waiter) waiter.finish(true);
				else this.#announced.set(name, (this.#announced.get(name) ?? 0) + 1);
				return;
			}
		}
	}

	#turnEnded(turn: Turn, response: PromptResponse): void {
		if (this.#turn !== turn || turn.cancelling) return;
		this.#turn = undefined;
		const step = this.#step;
		if (!step || step.writer.done || this.#pending) {
			this.#fail(new Error("Antigravity CLI ended a turn while its tool was still parked"));
			return;
		}
		if (response.stopReason === "cancelled") {
			this.#fail(new Error("Antigravity CLI cancelled the request"));
			return;
		}
		const writer = step.writer;
		if (
			!writer.output.content.some(
				block => (block.type === "text" && block.text.trim().length > 0) || block.type === "toolCall",
			)
		) {
			this.#fail(new Error("Antigravity CLI ended the request without a usable response"));
			return;
		}
		writer.usage(this.#contextTokens, response.usage);
		const digest = transcriptDigest([...step.messages, writer.output]);
		let checkpoint: AntigravityCliCheckpoint | undefined;
		if (response.stopReason === "end_turn") {
			try {
				checkpoint = readConversationCheckpoint(this.#geminiDir, turn.conversationId, digest);
			} catch {
				logger.debug("Antigravity CLI has no durable turn checkpoint; live continuation remains available");
			}
		}
		writer.finish(response.stopReason === "max_tokens" ? "length" : "stop", {
			type: "antigravityCli",
			conversationId: turn.conversationId,
			digest,
			checkpoint,
		});
		this.#ledger = { count: step.messages.length + 1, digest };
		step.done.resolve();
	}

	#fail(error: unknown): void {
		this.#ledger = undefined;
		const step = this.#step;
		if (step) {
			step.controller.abort(error);
			step.interrupted.reject(error);
			step.done.reject(error);
		}
		this.#stopProcess();
	}
}

/** Production ACP subprocess. Every resource is closed if spawning or setup throws. */
async function startTransport(options: AgyTransportOptions): Promise<AgyTransport> {
	const binary = await resolveAgyBinary();
	options.signal.throwIfAborted();
	if (!$which("nc")) throw new Error("Antigravity CLI needs nc (netcat) on PATH for its tool bridge");
	await writeAgentDefinition(options.geminiDir);
	options.signal.throwIfAborted();
	let closeProcess: (() => void) | undefined;
	const bridge = new McpBridge(options.tools, options.onCall, () => closeProcess?.());
	try {
		const child = Bun.spawn(
			[
				binary,
				"acp",
				"--agent",
				AGENT_NAME,
				"--gemini-dir",
				options.geminiDir,
				"--ide-mcp-port",
				String(bridge.port),
				"--dangerously-skip-permissions",
			],
			{
				cwd: options.cwd,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "ignore",
				env: { ...Bun.env, ...agyCredentialEnv(), AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
			},
		);
		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			bridge.close();
			child.kill("SIGKILL");
		};
		closeProcess = close;
		try {
			const input = new WritableStream<Uint8Array>({
				write: async chunk => {
					child.stdin.write(chunk);
					await child.stdin.flush();
				},
				close: async () => {
					await child.stdin.end();
				},
			});
			const connection = new ClientSideConnection(
				() => ({
					requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
					sessionUpdate: options.onUpdate,
				}),
				ndJsonStream(input, child.stdout),
			);
			return { connection, exited: child.exited, close };
		} catch (error) {
			close();
			throw error;
		}
	} catch (error) {
		bridge.close();
		throw error;
	}
}

async function writeAgentDefinition(geminiDir: string): Promise<void> {
	const file = Bun.file(path.join(geminiDir, "config", "agents", `${AGENT_NAME}.md`));
	if ((await file.exists()) && (await file.text()) === agentDefinition) return;
	await Bun.write(file, agentDefinition);
}

function systemMeta(system: string): Record<string, unknown> {
	return { antigravity: { systemPrompt: { append: system } } };
}

function thoughtLevel(options: SessionConfigOption[] | null | undefined): string | undefined {
	const option = options?.find(candidate => candidate.id === "thought_level");
	return option?.type === "select" ? option.currentValue : undefined;
}

function toMcpTool(tool: Tool): McpToolDefinition {
	const schema: unknown = normalizeSchemaForCCA(toolWireSchema(tool));
	if (!isRecord(schema)) throw new Error(`Invalid schema for Antigravity CLI tool ${tool.name}`);
	return { name: tool.name, description: tool.description, inputSchema: schema };
}

function toMcpOutput(result: ToolResultMessage): McpToolOutput {
	return {
		content: result.content.map(part =>
			part.type === "text"
				? { type: "text", text: part.text }
				: { type: "image", data: part.data, mimeType: part.mimeType },
		),
		isError: result.isError,
	};
}

function errorOutput(text: string): McpToolOutput {
	return { content: [{ type: "text", text }], isError: true };
}

function mapAgyError(error: unknown): Error {
	if (error instanceof RequestError && /not logged in|unauthenticated|authentication required/i.test(error.message)) {
		return new Error("Antigravity CLI is not signed in. Run /login and choose Antigravity CLI.");
	}
	return error instanceof Error ? error : new Error(String(error));
}

function scheduleTimer(delayMs: number, callback: () => void): AgyTimer {
	const timer = setTimeout(callback, delayMs);
	return { cancel: () => clearTimeout(timer) };
}

async function withTimeout<T>(operation: Promise<T>, ms: number, message: string, schedule: AgyScheduler): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = schedule(ms, () => timeout.reject(new Error(message)));
	try {
		return await Promise.race([operation, timeout.promise]);
	} finally {
		timer.cancel();
	}
}
