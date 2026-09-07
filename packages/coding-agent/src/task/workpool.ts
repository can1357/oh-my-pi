import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { CustomTool } from "../extensibility/custom-tools/types";
import workpoolBatchTemplate from "../prompts/tools/workpool-batch.md" with { type: "text" };
import workpoolTurnResultTemplate from "../prompts/tools/workpool-turn-result.md" with { type: "text" };
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import type { CustomMessage } from "../session/messages";
import type { ToolSession } from "../tools";
import { isIrcEnabled } from "../tools/hub";
import { ToolError } from "../tools/tool-errors";
import { runSubagentFollowUpTurn } from "./executor";
import {
	type EffectiveSubagentPolicy,
	reserveStructuredSubagentId,
	runStructuredSubagent,
} from "./structured-subagent";
import { type AgentProgress, oneLineLabel, type SingleResult, type TaskToolDetails } from "./types";
import { buildWorkPoolOutputSchema, type WorkPoolYieldItem } from "./workpool-yield";

/** One user-supplied unit tracked through a workpool batch. */
export interface WorkPoolItem {
	id: string;
	seq: number;
	text: string;
	agentId?: string;
	batchId?: string;
	status: "queued" | "running" | "completed" | "failed" | "cancelled";
}

/** Keep-alive subagent and its queued work within a pool. */
export interface WorkPoolAgent {
	id: string;
	index: number;
	state: "running" | "idle" | "dead";
	queue: WorkPoolItem[];
	turns: number;
	contextTokens?: number;
	contextWindow?: number;
	jobId?: string;
}

/** One turn assigned to a pool agent and tracked as an internal job. */
export interface WorkPoolBatch {
	id: string;
	agentId: string;
	items: WorkPoolItem[];
	jobId: string;
	startedAt: number;
	status: "running" | "completed" | "failed" | "cancelled";
	output?: string;
}

/** Aggregate pool activity returned by `WorkPool.status()`. */
export interface WorkPoolStatus {
	name: string;
	agent: string;
	limit: number;
	closed: boolean;
	freshAgents: boolean;
	agents: Array<{
		id: string;
		state: WorkPoolAgent["state"];
		queued: number;
		turns: number;
		contextTokens?: number;
		contextWindow?: number;
		current?: string;
	}>;
	items: Record<WorkPoolItem["status"], number>;
	batches: number;
}

/** Non-consuming batch snapshot returned by `WorkPool.peek()`. */
export interface WorkPoolPeekResult {
	batches: Array<{
		id: string;
		agent: string;
		items: string[];
		status: WorkPoolBatch["status"];
		output?: string;
	}>;
	pending: number;
}

/** Resolved policy and optional shared context used to create a pool. */
export interface WorkPoolCreateOptions {
	name: string;
	policy: EffectiveSubagentPolicy;
	context?: string;
	customTools?: CustomTool[];
}

interface TurnOutcome {
	exitCode: number;
	output: string;
	error?: string;
	aborted?: boolean;
	abortReason?: string;
}

const DELIVERY_OUTPUT_LIMIT = 6_000;

/** Dispatches queued items across keep-alive subagents under one aggregate job. */
export class WorkPool {
	readonly name: string;
	readonly ownerId: string;
	readonly session: ToolSession;
	readonly policy: EffectiveSubagentPolicy;
	readonly context?: string;
	readonly customTools: CustomTool[];
	readonly freshAgents: boolean;
	readonly agents: WorkPoolAgent[] = [];
	readonly items: WorkPoolItem[] = [];
	readonly batches: WorkPoolBatch[] = [];
	closed = false;
	rrCursor = 0;

	#nextSeq = 1;
	#nextAgentIndex = 1;
	#lastCardTs = 0;
	#dispatchChain: Promise<void> = Promise.resolve();
	#poolJobStarted = false;
	readonly #drainWaiters: PromiseWithResolvers<void>[] = [];
	readonly #freshQueue: WorkPoolItem[] = [];

	constructor(session: ToolSession, options: WorkPoolCreateOptions) {
		this.name = options.name;
		this.ownerId = session.getAgentId?.() ?? MAIN_AGENT_ID;
		this.session = session;
		this.policy = options.policy;
		this.context = options.context;
		this.customTools = options.customTools ?? [];
		this.freshAgents = session.settings.get("eval.workpool.freshAgents");
		if (!session.asyncJobManager) {
			throw new ToolError("workpool() needs the session's async job manager; unavailable here");
		}
		if (session.asyncJobManager.getJob(this.name)) {
			throw new ToolError(`workpool job id "${this.name}" already exists`);
		}
	}

	/** Current worker ceiling from the live `task.maxConcurrency` setting. */
	limit(): number {
		const configured = this.session.settings.get("task.maxConcurrency");
		return configured > 0 ? configured : Infinity;
	}

	/** Queue items and start the aggregate pool job on the first non-empty push. */
	push(texts: string[]): string[] {
		if (this.closed) throw new ToolError(`workpool ${this.name} is closed`);
		if (texts.length === 0) return [];
		const queued: WorkPoolItem[] = [];
		for (const text of texts) {
			const seq = this.#nextSeq++;
			const item: WorkPoolItem = { id: `${this.name}#${seq}`, seq, text, status: "queued" };
			this.items.push(item);
			queued.push(item);
		}
		this.#ensurePoolJob();
		for (const item of queued) this.#queueDispatch(item);
		return queued.map(item => item.id);
	}

	#ensurePoolJob(): void {
		if (this.#poolJobStarted) return;
		const manager = this.session.asyncJobManager;
		if (!manager) throw new ToolError("workpool() needs the session's async job manager; unavailable here");
		if (manager.getJob(this.name)) throw new ToolError(`workpool job id "${this.name}" already exists`);
		this.#poolJobStarted = true;
		const id = manager.register(
			"task",
			this.name,
			async ({ signal }) => {
				const onAbort = (): void => {
					this.close();
					for (const batch of this.batches) manager.cancel(batch.jobId, { ownerId: this.ownerId });
				};
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
				try {
					await this.#waitForDrain();
					const batchIds = this.batches.map(batch => batch.jobId);
					await Promise.allSettled(
						batchIds.flatMap(batchId => {
							const job = manager.getJob(batchId);
							return job ? [job.promise] : [];
						}),
					);
					manager.consumeJobResults(batchIds);
					manager.unwatchJobs(batchIds);
					this.closed = true;
					const summary = `Pool \`${this.name}\` drained: ${this.items.length} item(s), ${this.batches.length} batch(es).`;
					this.#card(signal.aborted ? "cancelled" : "completed", this.ownerId, summary);
					return this.#renderAggregateResult();
				} finally {
					signal.removeEventListener("abort", onAbort);
				}
			},
			{ id: this.name, ownerId: this.ownerId, queued: true },
		);
		if (id !== this.name) {
			manager.cancel(id, { ownerId: this.ownerId });
			throw new ToolError(`workpool job id "${this.name}" is unavailable`);
		}
	}

	async #waitForDrain(): Promise<void> {
		if (this.#isDrained()) return;
		const waiter = Promise.withResolvers<void>();
		this.#drainWaiters.push(waiter);
		await waiter.promise;
	}

	#isDrained(): boolean {
		return !this.items.some(item => item.status === "queued" || item.status === "running");
	}

	#notifyDrained(): void {
		if (!this.#isDrained()) return;
		for (const waiter of this.#drainWaiters.splice(0)) waiter.resolve();
	}

	#queueDispatch(item: WorkPoolItem): void {
		this.#dispatchChain = this.#dispatchChain
			.then(() => this.#dispatch(item))
			.catch(error => {
				if (item.status === "queued") item.status = "failed";
				logger.warn("workpool: item dispatch failed", {
					pool: this.name,
					item: item.id,
					error: error instanceof Error ? error.message : String(error),
				});
				this.#notifyDrained();
			});
	}

	#contextLoad(agent: WorkPoolAgent): number {
		const tokens = agent.contextTokens ?? 0;
		const window = agent.contextWindow;
		return window !== undefined && window > 0 ? tokens / window : tokens;
	}

	#leastLoadedIdle(): WorkPoolAgent | undefined {
		let selected: WorkPoolAgent | undefined;
		let selectedLoad = Infinity;
		for (const agent of this.agents) {
			if (agent.state !== "idle") continue;
			const load = this.#contextLoad(agent);
			if (load >= selectedLoad) continue;
			selected = agent;
			selectedLoad = load;
		}
		return selected;
	}

	async #dispatch(item: WorkPoolItem): Promise<void> {
		if (this.closed || item.status !== "queued") return;
		if (this.freshAgents) {
			if (this.agents.length < this.limit()) {
				await this.#spawn(item);
			} else {
				this.#freshQueue.push(item);
				this.#card("queued", this.name, `[${item.id}] ${item.text}`);
			}
			return;
		}
		const idle = this.#leastLoadedIdle();
		if (idle) {
			item.agentId = idle.id;
			idle.queue.push(item);
			this.#card("dispatched", idle.id, `[${item.id}] ${item.text}`);
			this.#drain(idle);
			return;
		}
		if (this.agents.length < this.limit()) {
			await this.#spawn(item);
			return;
		}
		const busy = this.#nextBusy();
		if (!busy) {
			await this.#spawn(item);
			return;
		}
		item.agentId = busy.id;
		busy.queue.push(item);
		this.#card("queued", busy.id, `[${item.id}] ${item.text}`);
	}

	async #spawn(item: WorkPoolItem): Promise<void> {
		const index = this.#nextAgentIndex++;
		const id = await reserveStructuredSubagentId(this.session, { label: `${this.name}-${index}` });
		if (this.closed || item.status !== "queued") return;
		const agent: WorkPoolAgent = { id, index, state: "running", queue: [item], turns: 0 };
		item.agentId = id;
		this.agents.push(agent);
		this.#card("spawned", id, `[${item.id}] ${item.text}`);
		this.#drain(agent);
	}

	#nextBusy(): WorkPoolAgent | undefined {
		if (this.agents.length === 0) return undefined;
		for (let offset = 0; offset < this.agents.length; offset++) {
			const index = (this.rrCursor + offset) % this.agents.length;
			const agent = this.agents[index];
			if (agent?.state === "running") {
				this.rrCursor = (index + 1) % this.agents.length;
				return agent;
			}
		}
		return undefined;
	}

	#drain(agent: WorkPoolAgent): void {
		if (agent.queue.length === 0) {
			agent.state = "idle";
			this.#notifyDrained();
			return;
		}
		const items = agent.queue.splice(0);
		const id = `${agent.id}-b${agent.turns + 1}`;
		const batch: WorkPoolBatch = {
			id,
			agentId: agent.id,
			items,
			jobId: id,
			startedAt: Date.now(),
			status: "running",
		};
		for (const item of items) {
			item.status = "running";
			item.agentId = agent.id;
			item.batchId = batch.id;
		}
		agent.state = "running";
		agent.jobId = batch.jobId;
		this.batches.push(batch);
		const message = this.#batchMessage(batch);
		if (agent.turns > 0) this.#card("batch", agent.id, message);
		this.#startTurn(agent, batch, message);
	}

	#batchMessage(batch: WorkPoolBatch): string {
		return prompt.render(workpoolBatchTemplate, {
			pool: this.name,
			batch: batch.id,
			items: batch.items.map((item, index) => ({ id: item.id, index: index + 1, text: item.text })),
		});
	}

	#startTurn(agent: WorkPoolAgent, batch: WorkPoolBatch, message: string): void {
		const manager = this.session.asyncJobManager;
		if (!manager) throw new ToolError("workpool() needs the session's async job manager; unavailable here");
		const workPoolYieldItems: WorkPoolYieldItem[] = batch.items.map((item, index) => ({
			id: item.id,
			index: index + 1,
		}));
		const outputSchema = buildWorkPoolOutputSchema(workPoolYieldItems);
		const jobId = manager.register(
			"task",
			batch.id,
			async ({ signal, reportProgress, markRunning }) => {
				markRunning();
				const onProgress = (progress: AgentProgress): void => {
					if (progress.contextTokens !== undefined) agent.contextTokens = progress.contextTokens;
					if (progress.contextWindow !== undefined) agent.contextWindow = progress.contextWindow;
					const details: TaskToolDetails = {
						projectAgentsDir: null,
						results: [],
						totalDurationMs: Date.now() - batch.startedAt,
						progress: [progress],
					};
					void reportProgress(`Running agent ${agent.id}...`, { ...details });
				};
				let result: SingleResult;
				try {
					if (agent.turns === 0) {
						const execution = await runStructuredSubagent({
							session: this.session,
							invocationKind: "eval",
							assignment: message,
							...(this.context ? { context: this.context } : {}),
							agent: this.policy.agentName,
							identity: { id: agent.id },
							customTools: this.customTools,
							outputSchema,
							schemaMode: "strict",
							workPoolYieldItems,
							keepAlive: true,
							retainArtifacts: true,
							shareEvalSession: false,
							enableIrc: isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0),
							signal,
							onProgress,
						});
						result = execution.result;
					} else {
						result = await runSubagentFollowUpTurn({
							id: agent.id,
							agent: this.policy.agent,
							message,
							outputSchema,
							outputSchemaMode: "strict",
							outputSchemaSource: "caller",
							workPoolYieldItems,
							signal,
							onProgress,
							eventBus: this.session.eventBus,
							subagentEventBus: this.session.subagentEventBus,
							artifactsDir: this.session.getSessionFile()?.slice(0, -6),
							maxRuntimeMs: this.session.settings.get("task.maxRuntimeMs"),
						});
					}
				} catch (error) {
					const output = error instanceof Error ? error.message : String(error);
					return this.#settleTurn(agent, batch, { exitCode: 1, output, error: output });
				}
				return this.#settleTurn(agent, batch, result);
			},
			{ id: batch.id, agentId: agent.id, ownerId: this.ownerId },
		);
		batch.jobId = jobId;
		agent.jobId = jobId;
		manager.watchJobs([jobId]);
	}

	#settleTurn(agent: WorkPoolAgent, batch: WorkPoolBatch, result: TurnOutcome): string {
		this.#finishTurn(agent, batch, result);
		const delivery = this.#renderTurnResult(agent, batch, result);
		if (batch.status !== "completed") throw new Error(delivery);
		return delivery;
	}

	#finishTurn(agent: WorkPoolAgent, batch: WorkPoolBatch, result: TurnOutcome): void {
		batch.status = result.aborted ? "cancelled" : result.exitCode !== 0 || result.error ? "failed" : "completed";
		batch.output = result.output;
		for (const item of batch.items) item.status = batch.status;
		agent.turns++;
		agent.jobId = undefined;
		const ref = AgentRegistry.global().get(agent.id);
		ref?.session?.setWorkPoolYieldItems([]);
		if (this.freshAgents) {
			agent.state = "dead";
			const index = this.agents.indexOf(agent);
			if (index !== -1) this.agents.splice(index, 1);
			const next = this.#freshQueue.shift();
			if (next) this.#queueDispatch(next);
			this.#notifyDrained();
			return;
		}
		if (ref && (ref.status === "idle" || ref.status === "parked")) {
			this.#drain(agent);
		} else {
			agent.state = "dead";
			const stranded = agent.queue.splice(0);
			const index = this.agents.indexOf(agent);
			if (index !== -1) this.agents.splice(index, 1);
			for (const item of stranded) {
				item.agentId = undefined;
				item.batchId = undefined;
				this.#queueDispatch(item);
			}
		}
		this.#notifyDrained();
	}

	#renderAggregateResult(): string {
		const lines = [
			`Pool \`${this.name}\` completed (${this.items.length} item(s), ${this.batches.length} batch(es)).`,
		];
		for (const batch of this.batches) {
			lines.push("", `## ${batch.id} · agent \`${batch.agentId}\` · ${batch.status}`);
			for (const item of batch.items) {
				lines.push(`- [${item.id}] ${item.status} — ${oneLineLabel(item.text)}`);
			}
			const output = batch.output?.trim();
			if (output) lines.push("", output);
			lines.push(`Transcript: history://${batch.agentId} · full output: agent://${batch.agentId}`);
		}
		lines.push("", "Pool queue drained.");
		return lines.join("\n");
	}

	#renderTurnResult(agent: WorkPoolAgent, batch: WorkPoolBatch, result: TurnOutcome): string {
		const remaining = this.items.filter(item => item.status === "queued" || item.status === "running").length;
		const output = result.output.trim() || result.error || result.abortReason || "(no output)";
		const renderedOutput =
			output.length <= DELIVERY_OUTPUT_LIMIT
				? output
				: `${output.slice(0, DELIVERY_OUTPUT_LIMIT)}\n[output truncated to ${DELIVERY_OUTPUT_LIMIT} characters]`;
		return prompt.render(workpoolTurnResultTemplate, {
			pool: this.name,
			agent: agent.id,
			batch: batch.id,
			status: batch.status,
			count: batch.items.length,
			multiple: batch.items.length !== 1,
			items: batch.items.map(item => ({ id: item.id, status: item.status, text: oneLineLabel(item.text) })),
			output: renderedOutput,
			remaining,
		});
	}

	/** Return current workers, item counts, and context usage. */
	status(): WorkPoolStatus {
		const counts: WorkPoolStatus["items"] = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
		for (const item of this.items) counts[item.status]++;
		return {
			name: this.name,
			agent: this.policy.agentName,
			limit: this.limit(),
			closed: this.closed,
			freshAgents: this.freshAgents,
			agents: this.agents.map(agent => ({
				id: agent.id,
				state: agent.state,
				queued: agent.queue.length,
				turns: agent.turns,
				...(agent.contextTokens !== undefined ? { contextTokens: agent.contextTokens } : {}),
				...(agent.contextWindow !== undefined ? { contextWindow: agent.contextWindow } : {}),
				...(agent.jobId ? { current: agent.jobId } : {}),
			})),
			items: counts,
			batches: this.batches.length,
		};
	}

	/** Return batch results without consuming the aggregate job delivery. */
	peek(): WorkPoolPeekResult {
		return {
			batches: this.batches.map(batch => ({
				id: batch.id,
				agent: batch.agentId,
				items: batch.items.map(item => item.id),
				status: batch.status,
				...(batch.output !== undefined ? { output: batch.output } : {}),
			})),
			pending: this.items.filter(item => item.status === "queued" || item.status === "running").length,
		};
	}

	/** Stop accepting work and cancel items not yet assigned to a turn. */
	close(): { dropped: string[] } {
		this.closed = true;
		const dropped: string[] = [];
		for (const item of this.items) {
			if (item.status !== "queued") continue;
			item.status = "cancelled";
			dropped.push(item.id);
		}
		for (const agent of this.agents) agent.queue.splice(0);
		this.#freshQueue.splice(0);
		this.#notifyDrained();
		return { dropped };
	}

	#card(
		mode: "spawned" | "dispatched" | "queued" | "batch" | "completed" | "cancelled",
		agentId: string,
		body: string,
	): void {
		const timestamp = Math.max(Date.now(), this.#lastCardTs + 1);
		this.#lastCardTs = timestamp;
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:workpool",
			content: `[pool ${this.name} → ${agentId}]\n\n${body}`,
			display: true,
			details: { pool: this.name, from: `pool:${this.name}`, to: agentId, body, mode },
			attribution: "agent",
			timestamp,
		};
		try {
			AgentRegistry.global().get(this.ownerId)?.session?.emitIrcRelayObservation(record);
		} catch (error) {
			logger.debug("workpool: card emission failed", {
				pool: this.name,
				agent: agentId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

/** Process-local workpool registry scoped by owner id and pool name. */
export class WorkPoolRegistry {
	static #instance: WorkPoolRegistry | undefined;

	/** Return the process-global workpool registry. */
	static global(): WorkPoolRegistry {
		WorkPoolRegistry.#instance ??= new WorkPoolRegistry();
		return WorkPoolRegistry.#instance;
	}

	/** Replace the global registry with an empty instance for tests. */
	static resetForTests(): void {
		WorkPoolRegistry.#instance = new WorkPoolRegistry();
	}

	readonly #pools = new Map<string, WorkPool>();

	#key(ownerId: string, name: string): string {
		return `${ownerId}\0${name}`;
	}

	/** Create a uniquely named pool for the session owner. */
	create(session: ToolSession, options: WorkPoolCreateOptions): WorkPool {
		const ownerId = session.getAgentId?.() ?? MAIN_AGENT_ID;
		const key = this.#key(ownerId, options.name);
		if (this.#pools.has(key)) throw new ToolError(`workpool "${options.name}" already exists`);
		const pool = new WorkPool(session, options);
		this.#pools.set(key, pool);
		return pool;
	}

	/** Find one pool without creating it. */
	get(ownerId: string, name: string): WorkPool | undefined {
		return this.#pools.get(this.#key(ownerId, name));
	}

	/** Close and forget every pool owned by an ending session. */
	releaseOwner(ownerId: string): void {
		for (const [key, pool] of this.#pools) {
			if (pool.ownerId !== ownerId) continue;
			pool.close();
			this.#pools.delete(key);
		}
	}
}
