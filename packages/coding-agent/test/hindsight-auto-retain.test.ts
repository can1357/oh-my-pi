/**
 * Auto-retain lifecycle: which session events trigger a transcript retain, and how
 * overlapping triggers (yielded pauses, the run's `agent_end`, `/memory enqueue`)
 * are serialized so at most one retain is in flight per session.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type {
	BankProfileResponse,
	CreateBankOptions,
	RetainOptions,
	RetainResponse,
} from "@oh-my-pi/pi-coding-agent/hindsight/client";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";

const makeConfig = (overrides: Partial<HindsightConfig> = {}): HindsightConfig => ({
	hindsightApiUrl: "http://localhost:8888",
	hindsightApiToken: null,
	bankId: null,
	bankIdPrefix: "",
	scoping: "global",
	globalScope: false,
	bankMission: "",
	retainMission: null,
	autoRecall: false,
	autoRetain: true,
	retainMode: "full-session",
	retainEveryNTurns: 1,
	retainOverlapTurns: 0,
	retainContext: "omp",
	recallBudget: "mid",
	recallMaxTokens: 1024,
	recallTypes: [],
	recallContextTurns: 1,
	recallMaxQueryChars: 800,
	recallPromptPreamble: "preamble",
	debug: false,
	requestTimeoutMs: 30_000,
	reflectTimeoutMs: 30_000,
	recallTimeoutMs: 30_000,
	retainTimeoutMs: 30_000,
	mentalModelsEnabled: false,
	mentalModelAutoSeed: false,
	mentalModelMaxRenderChars: 16_000,
	...overrides,
});

/** Retain stub whose calls block until the test releases them, tracking overlap. */
class GatedHindsightApi extends HindsightApi {
	calls: { transcript: string; options?: RetainOptions }[] = [];
	inFlight = 0;
	maxInFlight = 0;
	#gates: PromiseWithResolvers<void>[] = [];
	blocking = false;

	constructor() {
		super({ baseUrl: "http://localhost" });
	}

	override async createBank(_bankId: string, _options?: CreateBankOptions): Promise<BankProfileResponse> {
		return {};
	}

	override async retain(_bankId: string, transcript: string, options?: RetainOptions): Promise<RetainResponse> {
		this.calls.push({ transcript, options });
		this.inFlight++;
		this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
		try {
			if (this.blocking) {
				const gate = Promise.withResolvers<void>();
				this.#gates.push(gate);
				await gate.promise;
			}
			return {};
		} finally {
			this.inFlight--;
		}
	}

	release(): void {
		for (const gate of this.#gates.splice(0)) gate.resolve();
	}
}

function makeHarness(configOverrides: Partial<HindsightConfig> = {}) {
	const entries: unknown[] = [];
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const session = {
		sessionManager: { getEntries: () => entries },
		subscribe(listener: (event: AgentSessionEvent) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emitNotice: () => {},
	} as object as AgentSession;
	const client = new GatedHindsightApi();
	const state = new HindsightSessionState({
		sessionId: "sess",
		client,
		bankId: "bank",
		config: makeConfig(configOverrides),
		session,
		banksSet: new Set<string>(),
	});
	const flush = vi.spyOn(state.retainQueue, "flush").mockResolvedValue();
	state.attachSessionListeners();
	let turn = 0;
	return {
		client,
		state,
		flush,
		addTurn() {
			turn++;
			entries.push({ type: "message", message: { role: "user", content: `question ${turn}` } });
			entries.push({
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: `answer ${turn}` }] },
			});
		},
		emit(event: AgentSessionEvent) {
			for (const listener of listeners) listener(event);
		},
	};
}

const yieldedPause: AgentSessionEvent = { type: "agent_pause", messages: [], yielded: true, awaiting: true };
const agentEnd: AgentSessionEvent = { type: "agent_end", messages: [] };

/**
 * Listeners fire retains without exposing a promise; one macrotask turn drains every
 * microtask they chain (the stub resolves immediately unless gated), so this waits on
 * no wall-clock duration.
 */
const settle = () => Bun.sleep(0);

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Hindsight auto-retain triggers", () => {
	it("retains on a yielded agent_pause while the run stays open", async () => {
		const h = makeHarness();
		h.addTurn();
		h.emit(yieldedPause);
		await settle();

		expect(h.client.calls).toHaveLength(1);
		expect(h.client.calls[0].transcript).toContain("question 1");
		expect(h.flush).toHaveBeenCalledTimes(1);
	});

	it("does not retain on a non-yielded agent_pause (session continues the model's own work)", async () => {
		const h = makeHarness();
		h.addTurn();
		h.emit({ type: "agent_pause", messages: [], yielded: false, awaiting: false });
		await settle();

		expect(h.client.calls).toHaveLength(0);
		expect(h.flush).not.toHaveBeenCalled();
	});

	it("sends nothing for the run's agent_end when the preceding pause already retained its turns", async () => {
		const h = makeHarness();
		h.addTurn();
		h.emit(yieldedPause);
		await settle();
		h.emit(agentEnd);
		await settle();

		expect(h.client.calls).toHaveLength(1);
	});

	it("coalesces triggers during an in-flight retain into one follow-up carrying the latest turn", async () => {
		const h = makeHarness();
		h.client.blocking = true;
		h.addTurn();
		h.emit(yieldedPause);
		await settle();

		h.addTurn();
		h.emit(yieldedPause);
		h.addTurn();
		h.emit(yieldedPause);
		h.emit(agentEnd);
		await settle();

		h.client.blocking = false;
		h.client.release();
		await settle();

		expect(h.client.maxInFlight).toBe(1);
		expect(h.client.calls).toHaveLength(2);
		expect(h.client.calls[1].transcript).toContain("question 3");
	});

	it("serializes /memory enqueue behind an in-flight auto-retain and resends the full transcript", async () => {
		const h = makeHarness();
		h.client.blocking = true;
		h.addTurn();
		h.emit(yieldedPause);
		await settle();

		const forced = h.state.forceRetainCurrentSession();
		await settle();
		expect(h.client.calls).toHaveLength(1);

		h.client.blocking = false;
		h.client.release();
		await forced;

		expect(h.client.maxInFlight).toBe(1);
		expect(h.client.calls).toHaveLength(2);
		// No new messages since the auto-retain: the forced run still rebuilds from scratch.
		expect(h.client.calls[1].transcript).toBe(h.client.calls[0].transcript);
		expect(h.state.lastRetainedTurn).toBe(1);
	});
});
