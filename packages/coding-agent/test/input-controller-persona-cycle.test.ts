/**
 * Behavioral tests for InputController.cyclePersona — the Tab/Shift+Tab persona cycle.
 *
 * Oracle: the cycle contract as described in the feature and verified in the Round 2 review:
 *   - Primary agents (mode === "primary") are sorted by order asc, then alphabetically.
 *   - First Tab from no-persona loads index 0.
 *   - Shift+Tab from no-persona loads the last agent (I4).
 *   - Forward/backward wrap correctly.
 *   - Rapid Tab presses are debounced: the guard is synchronous, so a second call fired
 *     before the first await completes sees #personaCycleInFlight === true and returns early.
 *   - Non-primary agents are excluded from the rotation.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

beforeAll(() => {
	initTheme();
});

/** Minimal AgentDefinition for cycle tests. */
function makeAgent(name: string, mode: "primary" | "subagent" = "primary", order?: number): AgentDefinition {
	return {
		name,
		description: `${name} agent`,
		systemPrompt: `You are ${name}.`,
		mode,
		order,
		source: "user" as const,
	};
}

/** Three ordered primary agents used by most tests. */
const THREE_AGENTS = [
	makeAgent("alpha", "primary", 1),
	makeAgent("beta", "primary", 2),
	makeAgent("gamma", "primary", 3),
];

function createContext() {
	// Mutable state shared between the session mock and the test
	const state = { personaName: null as string | null };

	const applyAgentPersona = vi.fn(async (def: AgentDefinition | null) => {
		state.personaName = def?.name ?? null;
		return {};
	});

	const showStatus = vi.fn();
	const statusLine = { invalidate: vi.fn() };

	const ctx = {
		editor: {
			setActionKeys: vi.fn(),
			setCustomKeyHandler: vi.fn(),
			clearCustomKeyHandlers: vi.fn(),
			getText: () => "",
		} as unknown as InteractiveModeContext["editor"],
		ui: {
			requestRender: vi.fn(),
			addInputListener: vi.fn(),
			addStartListener: vi.fn(),
			getFocused: vi.fn(() => undefined),
		} as unknown as InteractiveModeContext["ui"],
		statusLine: statusLine as unknown as InteractiveModeContext["statusLine"],
		session: {
			get activePersonaName() {
				return state.personaName;
			},
			applyAgentPersona,
			isStreaming: false,
			isCompacting: false,
			isGeneratingHandoff: false,
			isBashRunning: false,
			isEvalRunning: false,
			queuedMessageCount: 0,
			extensionRunner: undefined,
			prompt: vi.fn(async () => {}),
			abort: vi.fn(async () => {}),
			settings: {
				get: (key: string) =>
					key === "task.disabledAgents" ? [] : key === "task.agentModelOverrides" ? {} : undefined,
			},
		} as unknown as InteractiveModeContext["session"],
		sessionManager: {
			getCwd: () => "/tmp/test-cwd",
		} as unknown as InteractiveModeContext["sessionManager"],
		keybindings: { getKeys: () => [] } as unknown as InteractiveModeContext["keybindings"],
		showStatus,
		updateEditorTopBorder: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		autoCompactionEscapeHandler: undefined,
		retryEscapeHandler: undefined,
		pendingImages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		isKnownSlashCommand: () => false,
		recordLocalSubmission: () => () => {},
		withLocalSubmission: async <T>(_text: string, fn: () => Promise<T>) => fn(),
		updatePendingMessagesDisplay: vi.fn(),
		isBashMode: false,
		isPythonMode: false,
		handleHotkeysCommand: vi.fn(),
		handlePlanModeCommand: vi.fn(),
		handleClearCommand: vi.fn(),
		showTreeSelector: vi.fn(),
		showUserMessageSelector: vi.fn(),
		showSessionSelector: vi.fn(),
		handleSTTToggle: vi.fn(),
		showDebugSelector: vi.fn(),
		showHistorySearch: vi.fn(),
		toggleThinkingBlockVisibility: vi.fn(),
		showModelSelector: vi.fn(),
		hasActiveBtw: vi.fn(() => false),
		showError: vi.fn(),
	} as unknown as InteractiveModeContext;

	return { ctx, applyAgentPersona, showStatus, statusLine, state };
}

describe("InputController.cyclePersona", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("first Tab (no persona) loads the first primary agent sorted by order", async () => {
		const { ctx, applyAgentPersona } = createContext();
		const controller = new InputController(ctx);

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			// Deliberately out-of-order to prove sorting
			agents: [makeAgent("gamma", "primary", 3), makeAgent("alpha", "primary", 1), makeAgent("beta", "primary", 2)],
			projectAgentsDir: null,
		});

		await controller.cyclePersona(1);

		expect(applyAgentPersona).toHaveBeenCalledTimes(1);
		expect(applyAgentPersona).toHaveBeenCalledWith(
			expect.objectContaining({ name: "alpha" }),
			expect.objectContaining({ mode: "cycle" }),
		);
	});

	it("advances to the next primary agent from the current persona", async () => {
		const { ctx, applyAgentPersona, state } = createContext();
		const controller = new InputController(ctx);
		state.personaName = "alpha";

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: THREE_AGENTS,
			projectAgentsDir: null,
		});

		await controller.cyclePersona(1);

		expect(applyAgentPersona).toHaveBeenCalledWith(
			expect.objectContaining({ name: "beta" }),
			expect.objectContaining({ mode: "cycle" }),
		);
	});

	it("forward Tab wraps from the last agent back to the first", async () => {
		const { ctx, applyAgentPersona, state } = createContext();
		const controller = new InputController(ctx);
		state.personaName = "gamma";

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: THREE_AGENTS,
			projectAgentsDir: null,
		});

		await controller.cyclePersona(1);

		expect(applyAgentPersona).toHaveBeenCalledWith(
			expect.objectContaining({ name: "alpha" }),
			expect.objectContaining({ mode: "cycle" }),
		);
	});

	it("first Shift+Tab (no persona) loads the last primary agent — I4 contract", async () => {
		const { ctx, applyAgentPersona } = createContext();
		const controller = new InputController(ctx);

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: THREE_AGENTS,
			projectAgentsDir: null,
		});

		await controller.cyclePersona(-1);

		expect(applyAgentPersona).toHaveBeenCalledWith(
			expect.objectContaining({ name: "gamma" }),
			expect.objectContaining({ mode: "cycle" }),
		);
	});

	it("backward Shift+Tab wraps from the first agent to the last", async () => {
		const { ctx, applyAgentPersona, state } = createContext();
		const controller = new InputController(ctx);
		state.personaName = "alpha";

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: THREE_AGENTS,
			projectAgentsDir: null,
		});

		await controller.cyclePersona(-1);

		expect(applyAgentPersona).toHaveBeenCalledWith(
			expect.objectContaining({ name: "gamma" }),
			expect.objectContaining({ mode: "cycle" }),
		);
	});

	it("excludes subagent-mode agents from the cycle", async () => {
		const { ctx, applyAgentPersona } = createContext();
		const controller = new InputController(ctx);

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [makeAgent("worker", "subagent", 0), makeAgent("solo", "primary", 1)],
			projectAgentsDir: null,
		});

		await controller.cyclePersona(1);

		expect(applyAgentPersona).toHaveBeenCalledWith(
			expect.objectContaining({ name: "solo" }),
			expect.objectContaining({ mode: "cycle" }),
		);
		expect(applyAgentPersona).not.toHaveBeenCalledWith(expect.objectContaining({ name: "worker" }));
	});

	it("is a no-op when no primary agents exist", async () => {
		const { ctx, applyAgentPersona } = createContext();
		const controller = new InputController(ctx);

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [makeAgent("worker", "subagent")],
			projectAgentsDir: null,
		});

		await controller.cyclePersona(1);

		expect(applyAgentPersona).not.toHaveBeenCalled();
	});

	it("is a no-op when Tab would reselect the already-active persona", async () => {
		const { ctx, applyAgentPersona } = createContext();
		const controller = new InputController(ctx);

		// Single enabled primary agent, already active — cyclePersona would
		// otherwise compute `next` as the same agent and still call
		// applyAgentPersona, appending a spurious persona_change/model_change
		// entry and re-running setModel() for zero actual change.
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [makeAgent("solo", "primary", 1)],
			projectAgentsDir: null,
		});
		await controller.cyclePersona(1);
		applyAgentPersona.mockClear();

		await controller.cyclePersona(1);

		expect(applyAgentPersona).not.toHaveBeenCalled();
	});

	it("sorts agents without an order value alphabetically after all ordered agents", async () => {
		const { ctx, applyAgentPersona } = createContext();
		const controller = new InputController(ctx);

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [
				makeAgent("zebra", "primary"), // no order — sorts last
				makeAgent("alpha", "primary", 1), // order: 1 — sorts first
			],
			projectAgentsDir: null,
		});

		await controller.cyclePersona(1);

		expect(applyAgentPersona).toHaveBeenCalledWith(
			expect.objectContaining({ name: "alpha" }),
			expect.objectContaining({ mode: "cycle" }),
		);
	});

	it("in-flight guard drops a concurrent second call — I1 contract", async () => {
		// The guard check and set are synchronous before the first await, so a second call
		// fired in the same synchronous turn will see #personaCycleInFlight === true and
		// return early — no real timer needed.
		const { ctx, applyAgentPersona } = createContext();
		const controller = new InputController(ctx);

		const { promise, resolve } = Promise.withResolvers<{ modelFailed?: string }>();
		applyAgentPersona.mockReturnValue(promise);

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [makeAgent("alpha", "primary", 1), makeAgent("beta", "primary", 2)],
			projectAgentsDir: null,
		});

		// p1 sets #personaCycleInFlight = true synchronously before its first await;
		// p2 sees the guard and returns immediately.
		const p1 = controller.cyclePersona(1);
		const p2 = controller.cyclePersona(1);

		resolve({});
		await Promise.all([p1, p2]);

		expect(applyAgentPersona).toHaveBeenCalledTimes(1);
	});

	it("shows a status flash with the newly loaded persona name", async () => {
		const { ctx, showStatus } = createContext();
		const controller = new InputController(ctx);

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [makeAgent("sisyphus", "primary", 1)],
			projectAgentsDir: null,
		});

		await controller.cyclePersona(1);

		expect(showStatus).toHaveBeenCalledWith("Persona: sisyphus");
	});
});

describe("no-primary persona-cycle-backward key preserves thinking-level cycle", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("cyclePersona(-1) returns early without applying a persona when no primary agents exist", async () => {
		const { ctx, applyAgentPersona } = createContext();
		const controller = new InputController(ctx);

		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [makeAgent("worker", "subagent")],
			projectAgentsDir: null,
		});

		await controller.cyclePersona(-1);

		expect(applyAgentPersona).not.toHaveBeenCalled();
	});
});

describe("stale #hasPrimaryAgents cache heals without restart", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("re-discovers and unblocks Tab after a first primary agent is added mid-session", async () => {
		const { ctx, applyAgentPersona } = createContext();

		// 1st discoverAgents call: eager priming when setupKeyHandlers() runs —
		// project starts with zero primary agents, so #hasPrimaryAgents correctly caches false.
		const discoverSpy = vi.spyOn(discovery, "discoverAgents").mockResolvedValueOnce({
			agents: [makeAgent("worker", "subagent")],
			projectAgentsDir: null,
		});

		const controller = new InputController(ctx);
		controller.setupKeyHandlers();
		// Let setupKeyHandlers()'s fire-and-forget #refreshHasPrimaryAgents() settle,
		// including its `.finally()` clearing #hasPrimaryAgentsRefreshInFlight —
		// needs a couple more microtask flushes past the discoverAgents promise itself.
		await discoverSpy.mock.results[0]?.value;
		await Promise.resolve();
		await Promise.resolve();

		const onForward = ctx.editor.onCyclePersonaForward;
		expect(onForward).toBeDefined();

		// 2nd discoverAgents call: queued BEFORE the Tab press that triggers the
		// background refresh, simulating the user having created their first
		// `mode: primary` agent via /agents while OMP kept running.
		discoverSpy.mockResolvedValueOnce({
			agents: [makeAgent("sisyphus", "primary", 1)],
			projectAgentsDir: null,
		});

		// Cache is still false at press time: Tab falls through to completion
		// (exactly as before this fix), but the press also fires the background
		// refresh that heals the cache for the NEXT press.
		expect(onForward?.()).toBe(false);
		expect(applyAgentPersona).not.toHaveBeenCalled();
		await discoverSpy.mock.results[1]?.value;
		await Promise.resolve();
		await Promise.resolve();

		// 3rd discoverAgents call: a subsequent Tab press now sees a healed cache
		// and cyclePersona() runs for real, discovering/applying the newly
		// created primary agent — no restart required.
		discoverSpy.mockResolvedValueOnce({
			agents: [makeAgent("sisyphus", "primary", 1)],
			projectAgentsDir: null,
		});
		onForward?.();
		await Promise.resolve();
		await Promise.resolve();

		expect(applyAgentPersona).toHaveBeenCalledWith(
			expect.objectContaining({ name: "sisyphus" }),
			expect.objectContaining({ mode: "cycle" }),
		);
	});
});

describe("delayed initial discovery does not misroute the first Tab press", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("routes to cyclePersona (not autocomplete) while the eager prime is still in flight", async () => {
		const { ctx, applyAgentPersona } = createContext();

		// The eager prime's discoverAgents() call never resolves within this
		// test's synchronous window — simulates a slow discovery scan racing
		// the very first keypress right after startup, before #hasPrimaryAgents
		// has moved past its initial "unknown" state.
		const { promise: primePromise, resolve: resolvePrime } = Promise.withResolvers<{
			agents: AgentDefinition[];
			projectAgentsDir: string | null;
		}>();
		const discoverSpy = vi.spyOn(discovery, "discoverAgents").mockReturnValueOnce(primePromise);

		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		// cyclePersona()'s own fresh discovery call, queued for when the Tab
		// handler below runs.
		discoverSpy.mockResolvedValueOnce({
			agents: [makeAgent("sisyphus", "primary", 1)],
			projectAgentsDir: null,
		});

		const onForward = ctx.editor.onCyclePersonaForward;
		expect(onForward).toBeDefined();

		// Press Tab before the initial prime settles: #hasPrimaryAgents is
		// `undefined` (unknown), not `false` — the guard must not treat unknown
		// as "no primary agents" and fall through to autocomplete.
		const result = onForward?.();
		expect(result).not.toBe(false);

		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(applyAgentPersona).toHaveBeenCalledWith(
			expect.objectContaining({ name: "sisyphus" }),
			expect.objectContaining({ mode: "cycle" }),
		);

		resolvePrime({ agents: [], projectAgentsDir: null });
	});
});
