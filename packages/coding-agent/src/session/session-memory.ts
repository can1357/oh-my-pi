/** Session memory backend lifecycle and transcript resets. */

import type { Agent, AgentTool } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { all as allSettings, combine, type Derived } from "../config/registry";
import type { Settings } from "../config/settings";
import type { HindsightSessionState } from "../hindsight/state";
import { resolveMemoryBackend } from "../memory-backend/resolve";
import type { MemoryBackend, MemoryBackendStartOptions, MemoryBackendStartReason } from "../memory-backend/types";
import { startSharpshooterLeg } from "../memory-backend/with-sharpshooter";
import type { MnemopiSessionState } from "../mnemopi/state";
import { releaseSharpshooterSession, sharpshooterBackend } from "../sharpshooter/backend";
import { cfgSharpshooterEnabled } from "../sharpshooter/settings";

import { cfgMemoryBackend } from "../memory-backend/settings";

/** Id prefixes of the memory backends' own settings; their live edits reconfigure the active backend. */
const MEMORY_BACKEND_SETTING_PREFIXES: readonly string[] = ["hindsight.", "mnemopi.", "sharpshooter."];

/** A backend's `applySettings` call for the edits that belong to it. */
interface SettingsHook {
	backend: MemoryBackend;
	own: string[];
}

let memorySettings: Derived<Record<string, unknown>> | undefined;

/** `memory.backend` plus every backend's own settings, keyed by setting id (built once registration is complete). */
function memorySettingsValue(): Derived<Record<string, unknown>> {
	memorySettings ??= combine(
		Object.fromEntries(
			allSettings()
				.filter(
					handle =>
						handle.id === cfgMemoryBackend.id ||
						MEMORY_BACKEND_SETTING_PREFIXES.some(prefix => handle.id.startsWith(prefix)),
				)
				.map(handle => [handle.id, handle]),
		),
	);
	return memorySettings;
}

/** Capabilities borrowed from the owning AgentSession. */
export interface SessionMemoryHost {
	agent: Agent;
	settings: Settings;
	modelRegistry: ModelRegistry;
	isDisposed(): boolean;
	/** Session working directory; memory bank scopes derive from it. */
	cwd(): string;
	/** Registers teardown to run when the session is disposed (settings listeners bound to this host). */
	addDisposer(dispose: () => void): void;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	memoryBackendSession(): MemoryBackendStartOptions["session"];
	getHindsightSessionState(): HindsightSessionState | undefined;
	setHindsightSessionState(state: HindsightSessionState | undefined): void;
	getMnemopiSessionState(): MnemopiSessionState | undefined;
	takeMnemopiSessionState(): MnemopiSessionState | undefined;
	setBaseSystemPrompt(prompt: string[]): void;
	refreshBaseSystemPrompt(): Promise<void>;
	replaceMemoryTools(tools: AgentTool[]): Promise<void>;
}

/** Owns memory backend transitions and transcript-scoped memory state. */
export class SessionMemory {
	readonly #host: SessionMemoryHost;
	readonly #memoryAgentDir: string | undefined;
	readonly #memoryTaskDepth: number;
	readonly #createMemoryTools: (() => Promise<AgentTool[]>) | undefined;
	#memoryBackendTransition: Promise<void> = Promise.resolve();
	#localMemoryStartupAbort: AbortController | undefined;
	#baseSystemPromptBeforeMemoryPromotion: string[] | undefined;
	/** Cwd the running backend state was built for; a transcript is never retained after it moved. */
	#runtimeCwd: string | undefined;
	/** Apply waiting behind the current transition; later requests join it. */
	#queuedApply: { retainMnemopi: boolean; reason?: MemoryBackendStartReason; done: Promise<void> } | undefined;
	/** Memory settings as last dispatched to `#applySettingsChange`; unset when live changes are disabled. */
	#observedSettings: Record<string, unknown> | undefined;
	/** Dispatched setting changes still running, including backend hooks that run outside the transition queue. */
	readonly #settingsChanges = new Set<Promise<void>>();

	constructor(
		host: SessionMemoryHost,
		options: {
			/** Session-start memory policy; false disables live backend changes. */
			memoryEnabled?: boolean;
			memoryAgentDir?: string;
			memoryTaskDepth?: number;
			createMemoryTools?: () => Promise<AgentTool[]>;
		},
	) {
		this.#host = host;
		this.#memoryAgentDir = options.memoryAgentDir;
		this.#memoryTaskDepth = options.memoryTaskDepth ?? 0;
		this.#createMemoryTools = options.createMemoryTools;
		if (this.#memoryAgentDir) this.#runtimeCwd = host.cwd();
		// Subagents alias the parent's backend state and never replace it live.
		if (options.memoryEnabled !== false && this.#memoryAgentDir && this.#memoryTaskDepth === 0) {
			const value = memorySettingsValue();
			this.#observedSettings = value.get(host.settings);
			value.listen(host, () => this.#observeSettings());
		}
	}

	/**
	 * Dispatches memory-setting edits not handled yet. The settings listener and
	 * {@link settle} both land here, so an edit starts exactly once, whichever
	 * observes it first.
	 */
	#observeSettings(): void {
		const previous = this.#observedSettings;
		if (!previous || this.#host.isDisposed()) return;
		const next = memorySettingsValue().get(this.#host.settings);
		const changed: string[] = [];
		for (const id in next) if (!Bun.deepEquals(next[id], previous[id])) changed.push(id);
		if (changed.length === 0) return;
		this.#observedSettings = next;
		const handling = this.#applySettingsChange(changed);
		this.#settingsChanges.add(handling);
		void handling.then(() => this.#settingsChanges.delete(handling));
	}

	/**
	 * Resolves once the runtime reflects every memory-setting edit made so far:
	 * starts edits the listener has not delivered yet, then waits out backend
	 * transitions and settings hooks until no new work arrives. Failed edits are
	 * reported by their handler; callers inspect the settled runtime themselves.
	 */
	async settle(): Promise<void> {
		let drained: Promise<void> | undefined;
		for (;;) {
			this.#observeSettings();
			const transition = this.#memoryBackendTransition;
			if (transition === drained && this.#settingsChanges.size === 0) return;
			drained = transition;
			await Promise.all([transition, ...this.#settingsChanges]);
		}
	}

	/**
	 * Live memory-setting edits: switching `memory.backend` re-applies everything;
	 * edits to the active backend's own `<id>.*` settings go to its
	 * `applySettings` hook, or re-apply the backend when it has none.
	 */
	async #applySettingsChange(changed: string[]): Promise<void> {
		try {
			if (changed.includes("memory.backend")) {
				await this.applyMemoryBackend();
				return;
			}
			// Queue synchronously, like a backend switch, so the next prompt's
			// transition drain orders after this edit.
			const hooks = await this.#enqueueTransition(async (): Promise<SettingsHook[]> => {
				if (this.#host.isDisposed()) return [];
				const backend = await resolveMemoryBackend(this.#host.settings);
				const hooks: SettingsHook[] = [];
				const own = changed.filter(path => path.startsWith(`${backend.id}.`));
				if (own.length > 0) {
					if (!backend.applySettings) {
						await this.#applyMemoryBackend(true);
						return hooks;
					}
					hooks.push({ backend, own });
				}
				// A paired Sharpshooter leg keeps the store's id, so its `sharpshooter.*`
				// edits never match the prefix above and need their own route.
				if (backend.id !== sharpshooterBackend.id) {
					const paired = changed.filter(path => path.startsWith(`${sharpshooterBackend.id}.`));
					if (paired.includes(cfgSharpshooterEnabled.id)) await this.applyPairedMemoryBackend("start");
					else if (paired.length > 0 && cfgSharpshooterEnabled.get(this.#host.settings)) {
						// Inside the transition, unlike the primary's hook: it only
						// rebuilds the prompt (never re-enters an apply), and turn
						// preparation waits on the transition, not on hooks, so a
						// prompt submitted mid-rebuild would see the old budget.
						await sharpshooterBackend.applySettings?.(this.#host.memoryBackendSession(), paired);
					}
				}
				return hooks;
			});
			// Backend hooks may re-enter `applyMemoryBackend`, so they run outside the transition.
			for (const hook of hooks) await hook.backend.applySettings?.(this.#host.memoryBackendSession(), hook.own);
		} catch (error) {
			logger.warn("Memory lifecycle: applying setting change failed", { changed, error: String(error) });
			this.#host.emitNotice("error", `Failed to apply memory settings: ${String(error)}`, "Memory");
		}
	}

	/** Current serialized backend transition, used by prompt and disposal drains. */
	get transition(): Promise<void> {
		return this.#memoryBackendTransition;
	}

	/** Base prompt captured before a per-turn memory promotion. */
	get promotionSnapshot(): string[] | undefined {
		return this.#baseSystemPromptBeforeMemoryPromotion;
	}

	/** Clears the per-turn memory promotion after a canonical prompt rebuild. */
	clearPromotionSnapshot(): void {
		this.#baseSystemPromptBeforeMemoryPromotion = undefined;
	}

	/** Captures the canonical prompt before the first per-turn memory promotion. */
	capturePromotionSnapshot(prompt: string[]): void {
		this.#baseSystemPromptBeforeMemoryPromotion ??= prompt;
	}

	/** Restores a promotion snapshot while rolling back a failed session switch. */
	restorePromotionSnapshot(prompt: string[] | undefined): void {
		this.#baseSystemPromptBeforeMemoryPromotion = prompt;
	}
	/** Rekeys every active memory backend to the current provider session. */
	rekeyForCurrentSessionId(): void {
		this.#rekeyHindsightMemoryForCurrentSessionId();
		this.#rekeyMnemopiMemoryForCurrentSessionId();
	}

	#rekeyHindsightMemoryForCurrentSessionId(): void {
		if (cfgMemoryBackend.get(this.#host.settings) !== "hindsight") return;
		const sid = this.#host.agent.sessionId;
		if (!sid) return;
		this.#host.getHindsightSessionState()?.setSessionId(sid);
	}

	#rekeyMnemopiMemoryForCurrentSessionId(): void {
		if (cfgMemoryBackend.get(this.#host.settings) !== "mnemopi") return;
		const sid = this.#host.agent.sessionId;
		if (!sid) return;
		this.#host.getMnemopiSessionState()?.setSessionId(sid);
	}

	/** New transcript: reset Hindsight counters and reload its frozen mental-model snapshot. */
	#resetHindsightConversationTrackingIfHindsight(): boolean {
		if (cfgMemoryBackend.get(this.#host.settings) !== "hindsight") return false;
		const state = this.#host.getHindsightSessionState();
		if (!state || state.aliasOf) return false;
		state.resetConversationTracking();
		// Start a bounded first-turn reload without delaying /new, fork, clear, or
		// session switches. A slow result is discarded so the previous snapshot
		// remains byte-stable for this transcript (#11961).
		state.beginMentalModelsTranscriptReload();
		return true;
	}

	#resetMnemopiConversationTrackingIfMnemopi(): boolean {
		if (cfgMemoryBackend.get(this.#host.settings) !== "mnemopi") return false;
		const state = this.#host.getMnemopiSessionState();
		if (!state || state.aliasOf) return false;
		state.resetConversationTracking();
		return true;
	}

	/** Resets transcript-scoped memory counters and removes a promoted prompt. */
	async resetContextForNewTranscript(): Promise<void> {
		const hadPromotedMemoryPrompt = this.#baseSystemPromptBeforeMemoryPromotion !== undefined;
		const resetHindsight = this.#resetHindsightConversationTrackingIfHindsight();
		const resetMnemopi = this.#resetMnemopiConversationTrackingIfMnemopi();
		if (hadPromotedMemoryPrompt) {
			this.#host.setBaseSystemPrompt(this.#baseSystemPromptBeforeMemoryPromotion!);
			this.#baseSystemPromptBeforeMemoryPromotion = undefined;
		}
		if (resetHindsight || resetMnemopi || hadPromotedMemoryPrompt) {
			await this.#host.refreshBaseSystemPrompt();
		}
	}

	/** Cancel the local rollout-memory startup owned by this session. */
	cancelLocalMemoryStartup(): void {
		this.#localMemoryStartupAbort?.abort();
		this.#localMemoryStartupAbort = undefined;
	}

	/** Start a new local rollout-memory generation and cancel its predecessor. */
	beginLocalMemoryStartup(): AbortSignal {
		this.cancelLocalMemoryStartup();
		const controller = new AbortController();
		this.#localMemoryStartupAbort = controller;
		return controller.signal;
	}

	/** Release the local startup slot if `signal` still owns it. */
	endLocalMemoryStartup(signal: AbortSignal): void {
		if (this.#localMemoryStartupAbort?.signal === signal) this.#localMemoryStartupAbort = undefined;
	}

	async #disposeMemoryBackendState(
		consolidateMnemopi = true,
		retainMnemopi = true,
		keepPendingExtractions = false,
	): Promise<void> {
		this.cancelLocalMemoryStartup();
		try {
			releaseSharpshooterSession(this.#host.memoryBackendSession(), { keepPending: keepPendingExtractions });
		} catch (error) {
			logger.warn("Memory lifecycle: Sharpshooter dispose failed", { error: String(error) });
		}
		const hindsight = this.#host.getHindsightSessionState();
		if (hindsight) {
			try {
				await hindsight.flushRetainQueue();
			} catch (error) {
				logger.warn("Memory lifecycle: Hindsight flush failed", { error: String(error) });
			}
			this.#host.setHindsightSessionState(undefined);
			hindsight.dispose();
		}

		const mnemopi = this.#host.takeMnemopiSessionState();
		if (mnemopi) {
			try {
				await mnemopi.dispose({ consolidate: consolidateMnemopi, retain: retainMnemopi });
			} catch (error) {
				logger.warn("Memory lifecycle: Mnemopi dispose failed", { error: String(error) });
			}
		}
	}

	/**
	 * Apply the selected memory backend to runtime state, tools, and prompt.
	 * Concurrent settings changes run in order and settle before the next turn;
	 * requests arriving while an apply is still queued join it, since it reads
	 * settings only once it starts. Cwd rebinding can disable Mnemopi
	 * auto-retention without skipping its drain.
	 */
	async applyMemoryBackend(
		options: { retainMnemopi?: boolean; reason?: MemoryBackendStartReason } = {},
	): Promise<void> {
		if (this.#host.isDisposed()) return;
		const retainMnemopi = options.retainMnemopi !== false;
		const queued = this.#queuedApply;
		if (queued) {
			queued.retainMnemopi &&= retainMnemopi;
			// A cwd rebind never catches up on the transcript the outgoing scope
			// leaves behind, so a rebind reason must not be weakened by a queued
			// default-reason request it overtakes.
			if (queued.reason !== "rebind") queued.reason = options.reason ?? queued.reason;
			return queued.done;
		}
		const request = { retainMnemopi, reason: options.reason, done: Promise.resolve() };
		this.#queuedApply = request;
		request.done = this.#enqueueTransition(() => {
			this.#queuedApply = undefined;
			return this.#applyMemoryBackend(request.retainMnemopi, request.reason);
		});
		await request.done;
	}

	/** Runs `work` after every earlier transition; its failure does not block later ones. */
	#enqueueTransition<T>(work: () => Promise<T>): Promise<T> {
		const transition = this.#memoryBackendTransition.then(work);
		this.#memoryBackendTransition = transition.then(
			() => undefined,
			() => undefined,
		);
		return transition;
	}

	/**
	 * The reason a backend start decided now should carry. A session cwd that has moved
	 * past the applied one means the start IS the move's rebind, not a fresh start, and
	 * must not catch up on the transcript the source project left behind. Evaluate it
	 * right before the start, after the last await: a move can land during a teardown
	 * or a lazy backend import, and a reason fixed earlier is stale by then.
	 */
	startReason(requested: MemoryBackendStartReason = "start"): MemoryBackendStartReason {
		return (this.#runtimeCwd ?? this.#host.cwd()) !== this.#host.cwd() ? "rebind" : requested;
	}

	/**
	 * Start, restart or release only the paired decision backend, leaving the
	 * selected store's live state untouched.
	 *
	 * Two callers, and for both a full `applyMemoryBackend` would be wrong rather
	 * than merely heavy, because it disposes the selected store and builds a new
	 * one. A fresh `HindsightSessionState` starts at `lastRetainedTurn: 0` with an
	 * empty transcript cache and `hasRecalledForFirstTurn: false`, so the next
	 * `agent_end` re-retains the whole conversation under a new document and
	 * first-turn recall fires a second time.
	 *
	 * A cwd move is one caller. `rebindMemoryBackendForCwd` skips the full apply
	 * while a Hindsight transition owns the backend, so that it does not retry a
	 * partially torn-down store outside its own task, and Sharpshooter still has
	 * to follow: it keys its decision bank and its per-bank scheduler on cwd, so
	 * skipping leaves it consolidating the project the session just left and
	 * ignoring the destination project's own `sharpshooter.enabled`. The
	 * destination decides both ways, and a destination that turns pairing off has
	 * to take the source's subscription and scheduler with it.
	 *
	 * A live `sharpshooter.enabled` toggle is the other. Nothing caches what
	 * `resolveMemoryBackend` returns, so search and status pick the flag up on
	 * their own; what needs doing is exactly this, the session resources and the
	 * prompt.
	 *
	 * Sharpshooter selected as the backend is left alone either way. The flag is
	 * documented as ignored there, and it rebinds through the normal apply.
	 *
	 * Every branch that changed anything ends with a prompt rebuild. Sharpshooter's
	 * decision files are injected as developer instructions, and the Hindsight
	 * rebuild a move runs beside this refreshes the base prompt only when its own
	 * bank scope changed, which a `global` scope or an unchanged bank never does.
	 */
	async applyPairedMemoryBackend(reason: MemoryBackendStartReason): Promise<void> {
		if (this.#host.isDisposed()) return;
		if (!this.#memoryAgentDir || this.#memoryTaskDepth !== 0) return;
		const settings = this.#host.settings;
		const backend = cfgMemoryBackend.get(settings);
		if (backend === "sharpshooter") return;
		// A move's settings reload is drained by its first settle, ahead of the explicit
		// rebind, so a pairing toggle can arrive here while the session cwd is already past
		// the applied one: startReason turns that start into the move's rebind.
		const finishesMove = reason === "rebind";
		reason = this.startReason(reason);
		const session = this.#host.memoryBackendSession();
		if (cfgSharpshooterEnabled.get(settings)) {
			startSharpshooterLeg(
				{
					session,
					settings,
					modelRegistry: this.#host.modelRegistry,
					agentDir: this.#memoryAgentDir,
					taskDepth: this.#memoryTaskDepth,
					reason,
				},
				backend ?? "off",
			);
		} else {
			releaseSharpshooterSession(session);
		}
		// The explicit rebind is the move's last step for a Hindsight session, which never
		// reaches the full apply that otherwise commits the applied cwd. Left at the source,
		// every later pairing toggle would read as part of a move and skip its catch-up.
		if (finishesMove) this.#runtimeCwd = this.#host.cwd();
		if (this.#host.isDisposed()) return;
		await this.#host.refreshBaseSystemPrompt();
	}

	async #applyMemoryBackend(retainMnemopi = true, reason: MemoryBackendStartReason = "start"): Promise<void> {
		if (this.#host.isDisposed()) return;
		const cwd = this.#host.cwd();
		// A cwd move (or its rollback) may reach here before the rebind does:
		// drain the outgoing state without capturing the transcript under a stale scope.
		const retain = retainMnemopi && (this.#runtimeCwd ?? cwd) === cwd;
		// A full apply that runs while the session cwd has moved past the applied
		// cwd IS the move's rebind, not a fresh start: it must not catch up on a
		// transcript the destination never earned.
		if ((this.#runtimeCwd ?? cwd) !== cwd) reason = "rebind";
		try {
			const startsLeg = () =>
				this.#memoryAgentDir !== undefined &&
				this.#memoryTaskDepth === 0 &&
				!this.#host.isDisposed() &&
				(cfgMemoryBackend.get(this.#host.settings) === "sharpshooter" ||
					cfgSharpshooterEnabled.get(this.#host.settings));
			// Keep prompts queued behind a slow extraction only when this apply starts
			// Sharpshooter again: the new leg carries them. Decided before the release,
			// because teardown of a slow store leaves a window in which an extraction
			// that settles would drain a queue whose subscription is already gone.
			await this.#disposeMemoryBackendState(true, retain, startsLeg());
			this.#runtimeCwd = cwd;
			// Settings can change during the teardown, so a leg expected above may no
			// longer start; whatever is still queued then has no leg to retry it.
			if (!startsLeg()) releaseSharpshooterSession(this.#host.memoryBackendSession());
			if (this.#memoryAgentDir && this.#memoryTaskDepth === 0 && !this.#host.isDisposed()) {
				const backend = await resolveMemoryBackend(this.#host.settings);
				// Resolution is an await too: pairing can be switched off while a cold store
				// import loads, and the queue kept above then has no leg left to run it.
				if (!startsLeg()) releaseSharpshooterSession(this.#host.memoryBackendSession());
				await backend.start({
					session: this.#host.memoryBackendSession(),
					settings: this.#host.settings,
					modelRegistry: this.#host.modelRegistry,
					agentDir: this.#memoryAgentDir,
					taskDepth: this.#memoryTaskDepth,
					reason: this.startReason(reason),
				});
			}
			if (this.#host.isDisposed()) return;
			await this.#refreshMemoryTools();
			if (this.#host.isDisposed()) return;
			await this.#host.refreshBaseSystemPrompt();
		} catch (error) {
			await this.#disposeMemoryBackendState(false);
			if (!this.#host.isDisposed()) {
				await this.#replaceMemoryTools([]).catch(refreshError => {
					logger.warn("Failed to remove memory tools after backend apply error", {
						error: String(refreshError),
					});
				});
			}
			throw error;
		}
	}

	async #refreshMemoryTools(): Promise<void> {
		const tools = (await this.#createMemoryTools?.()) ?? [];
		await this.#replaceMemoryTools(tools);
	}

	#replaceMemoryTools(tools: AgentTool[]): Promise<void> {
		return this.#host.replaceMemoryTools(tools);
	}
}
