/**
 * Keeps one Antigravity CLI tool call alive past the MCP window: the parked MCP
 * response is released with a relay notice, and `omp_await_result` returns the
 * original result once omp supplies it. A result is never executed twice.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import type { McpToolDefinition, McpToolOutput } from "./mcp-bridge";
import relayControlTemplate from "./relay-control.md" with { type: "text" };
import relayNoticeTemplate from "./relay-notice.md" with { type: "text" };

export const RELAY_CONTROL_NAME = "omp_await_result";

const MIN_THRESHOLD_MS = 5_000;
const MAX_THRESHOLD_MS = 165_000;
const MISSING_RESULT = "The original tool call returned no result";

/** One relay threshold resolved from `OMP_ACP_TOOL_RELAY_MS`. */
export interface RelayConfig {
	enabled: boolean;
	thresholdMs: number;
}

/**
 * Read the relay window. Relay is opt-in: an absent, zero or unusable
 * `OMP_ACP_TOOL_RELAY_MS` disables it, and a positive value clamps to 5s..165s.
 */
export function resolveRelayConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
	const raw = env.OMP_ACP_TOOL_RELAY_MS?.trim();
	const value = raw ? Number(raw) : 0;
	if (!Number.isFinite(value) || value <= 0) return { enabled: false, thresholdMs: 0 };
	return {
		enabled: true,
		thresholdMs: Math.min(MAX_THRESHOLD_MS, Math.max(MIN_THRESHOLD_MS, Math.trunc(value))),
	};
}

/** Extra MCP tool agy may call; omp never projects it into its own tool list. */
export const RELAY_CONTROL_TOOL: McpToolDefinition = {
	name: RELAY_CONTROL_NAME,
	description: prompt.render(relayControlTemplate, { controlName: RELAY_CONTROL_NAME }),
	inputSchema: {
		type: "object",
		properties: { call_id: { type: "string", minLength: 1 } },
		required: ["call_id"],
		additionalProperties: false,
	},
};

/** The notice agy sees instead of a result that is still outstanding. */
export function relayNotice(callId: string): string {
	return prompt.render(relayNoticeTemplate, { controlName: RELAY_CONTROL_NAME, callId });
}

export interface RelayInvocation {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

/** Clock seam keeps relay windows deterministic in tests. */
export interface RelayClock {
	setTimeout: (callback: () => void, ms: number) => unknown;
	clearTimeout: (timer: unknown) => void;
}

const systemClock: RelayClock = {
	setTimeout: (callback, ms) => {
		const timer = setTimeout(callback, ms);
		timer.unref?.();
		return timer;
	},
	clearTimeout: timer => clearTimeout(timer as NodeJS.Timeout),
};

type RelayState = "pending" | "relayed" | "fulfilled" | "failed" | "cancelled";

type RelayWaitOutcome = "settled" | "timeout" | "detached";

/** One registered wait; calling it settles the wait exactly once. */
type RelayWait = (outcome: RelayWaitOutcome) => void;

interface RelayRecord {
	readonly callId: string;
	readonly turn: number;
	readonly name: string;
	readonly argumentsKey: string;
	state: RelayState;
	result?: McpToolOutput;
	readonly timers: Set<unknown>;
	readonly wakers: Set<RelayWait>;
	/** Control calls actually waiting on this id; a stopped transport's waiter is detached. */
	readonly waiters: Set<RelayWait>;
}

/** Per-call relay state for one Antigravity CLI host. */
export class ToolRelay {
	readonly #records = new Map<string, RelayRecord>();
	#turn = 0;

	constructor(
		readonly config: RelayConfig,
		readonly clock: RelayClock = systemClock,
	) {}

	get enabled(): boolean {
		return this.config.enabled;
	}

	get thresholdMs(): number {
		return this.config.thresholdMs;
	}

	/** Advance the awaitable window; older records expire. */
	beginTurn(): number {
		this.#turn += 1;
		this.#prune();
		return this.#turn;
	}

	/**
	 * Hold the parked MCP response for at most the threshold. On timeout the
	 * caller receives the relay notice and the record stays awaitable.
	 */
	async park(
		invocation: RelayInvocation,
		result: Promise<McpToolOutput>,
		onRelayed?: () => void,
	): Promise<McpToolOutput> {
		if (!this.config.enabled) return result;
		const record = this.#create(invocation);
		void result.then(
			output => this.settle(record.callId, output),
			() => this.settle(record.callId, relayError("The original tool call failed before returning a result")),
		);
		const outcome = await this.#wait(record, this.config.thresholdMs);
		if (record.state === "cancelled") return record.result ?? relayError(MISSING_RESULT);
		if (outcome === "settled") return record.result ?? relayError(MISSING_RESULT);
		record.state = "relayed";
		onRelayed?.();
		return noticeOutput(record.callId);
	}

	/** Store the original result exactly once; later deliveries are ignored. */
	settle(callId: string, result: McpToolOutput): void {
		const record = this.#records.get(callId);
		if (!record || record.state === "cancelled" || this.#isSettled(record)) return;
		record.state = result.isError ? "failed" : "fulfilled";
		record.result = result;
		this.#wake(record);
	}

	/** Return the stored result, or wait one threshold for it and repeat the notice. */
	async awaitResult(callId: string): Promise<McpToolOutput> {
		if (!this.config.enabled) return relayError("Tool relay is disabled");
		const record = this.#records.get(callId);
		if (!record) return relayError("Unknown or expired relay call id");
		if (record.turn < this.#turn - 1) return relayError("Relay call id belongs to an expired turn");
		if (record.turn > this.#turn) return relayError("Relay call id belongs to a future turn");
		if (this.#isSettled(record)) return record.result ?? relayError(MISSING_RESULT);
		const outcome = await this.#wait(record, this.config.thresholdMs, true);
		if (record.state === "cancelled") return record.result ?? relayError(MISSING_RESULT);
		if (outcome === "settled") return record.result ?? relayError(MISSING_RESULT);
		if (outcome === "detached")
			return relayError("The relay transport stopped before this control call got a result");
		return noticeOutput(record.callId);
	}

	/** True while a control call is actually waiting for this id. */
	awaiting(callId: string): boolean {
		return (this.#records.get(callId)?.waiters.size ?? 0) > 0;
	}

	/**
	 * Stop counting control calls whose transport stopped. Their socket can no
	 * longer receive the result, so a restarted process needs it as a late prompt.
	 */
	detach(callId: string | undefined): void {
		const record = callId === undefined ? undefined : this.#records.get(callId);
		if (!record) return;
		const waiters = [...record.waiters];
		record.waiters.clear();
		for (const waiter of waiters) waiter("detached");
	}

	/** Stop the threshold countdown for a call whose result is already in hand. */
	hold(callId: string | undefined): void {
		const record = callId === undefined ? undefined : this.#records.get(callId);
		if (!record) return;
		for (const timer of record.timers) this.clock.clearTimeout(timer);
		record.timers.clear();
	}

	/** Notice for an identical call already outstanding in this turn, so it never runs twice. */
	duplicateNotice(name: string, args: Record<string, unknown>): McpToolOutput | undefined {
		if (!this.config.enabled) return undefined;
		const argumentsKey = canonicalArguments(args);
		for (const record of this.#records.values()) {
			if (record.turn !== this.#turn || record.name !== name || record.argumentsKey !== argumentsKey) continue;
			if (record.state !== "pending" && record.state !== "relayed") continue;
			return noticeOutput(record.callId);
		}
		return undefined;
	}

	/**
	 * Fail every outstanding call; used when the host or its process stops.
	 * `except` keeps one released call awaitable across that restart, and its
	 * dead control waiters are detached first by {@link detach}.
	 */
	cancelAll(reason: string, except?: string): void {
		for (const record of this.#records.values()) {
			if (record.callId === except || this.#isSettled(record)) continue;
			record.state = "cancelled";
			record.result = relayError(reason);
			this.#wake(record);
		}
	}

	#create(invocation: RelayInvocation): RelayRecord {
		const record: RelayRecord = {
			callId: invocation.id,
			turn: this.#turn,
			name: invocation.name,
			argumentsKey: canonicalArguments(invocation.arguments),
			state: "pending",
			timers: new Set(),
			wakers: new Set(),
			waiters: new Set(),
		};
		this.#records.set(record.callId, record);
		return record;
	}

	#isSettled(record: RelayRecord): boolean {
		return record.state === "fulfilled" || record.state === "failed" || record.state === "cancelled";
	}

	#wake(record: RelayRecord): void {
		const wakers = [...record.wakers];
		record.wakers.clear();
		for (const waker of wakers) waker("settled");
	}

	/** `control` marks the wait as an `omp_await_result` call, which `awaiting()` counts. */
	#wait(record: RelayRecord, ms: number, control = false): Promise<RelayWaitOutcome> {
		if (this.#isSettled(record)) return Promise.resolve("settled");
		const waiting = Promise.withResolvers<RelayWaitOutcome>();
		let done = false;
		const finish: RelayWait = outcome => {
			if (done) return;
			done = true;
			record.wakers.delete(finish);
			record.waiters.delete(finish);
			if (timer) {
				record.timers.delete(timer);
				this.clock.clearTimeout(timer);
			}
			waiting.resolve(outcome);
		};
		const timer = this.clock.setTimeout(() => finish("timeout"), ms);
		record.timers.add(timer);
		record.wakers.add(finish);
		if (control) record.waiters.add(finish);
		return waiting.promise;
	}

	#prune(): void {
		const oldestAwaitableTurn = this.#turn - 1;
		for (const [callId, record] of this.#records) {
			if (record.turn >= oldestAwaitableTurn) continue;
			if (!this.#isSettled(record)) {
				record.state = "cancelled";
				record.result = relayError("Relay call id belongs to an expired turn");
				this.#wake(record);
			}
			this.#records.delete(callId);
		}
	}
}

function relayError(message: string): McpToolOutput {
	return { content: [{ type: "text", text: message }], isError: true };
}

function noticeOutput(callId: string): McpToolOutput {
	return { content: [{ type: "text", text: relayNotice(callId) }], isError: false };
}

/** Stable key for argument equality across retries of the same call. */
function canonicalArguments(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalArguments).join(",")}]`;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonicalArguments(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}
