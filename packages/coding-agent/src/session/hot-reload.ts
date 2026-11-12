/**
 * Unified session hot-reload coordinator, subsystem contract, and `hotReload.*` settings.
 *
 * Every hot-reloadable surface in a session (custom tools, skills, extensions,
 * MCP config files, and the omp executable itself) implements {@link HotReloadSubsystem}
 * and registers with {@link HotReloadCoordinator}. Extending hot-reload to a new
 * subsystem requires only implementing {@link HotReloadSubsystem} and calling
 * `coordinator.register(subsystem)` (or `session.registerHotReloadSubsystem(subsystem)`).
 */
import { combine, type Derived } from "../config/registry";
import {
	cfgHotReloadBinary,
	cfgHotReloadEnabled,
	cfgHotReloadExtensions,
	cfgHotReloadMcpConfig,
	cfgHotReloadMcpServers,
	cfgHotReloadSkills,
	cfgHotReloadTools,
} from "./settings";

export const DEFAULT_HOT_RELOAD_POLL_MS = 2_000;

export interface HotReloadState {
	readonly enabled: boolean;
	readonly tools: boolean;
	readonly skills: boolean;
	readonly extensions: boolean;
	readonly mcpConfig: boolean;
	readonly mcpServers: boolean;
	readonly binary: boolean;
}

const cfgHotReloadInputs = combine({
	enabled: cfgHotReloadEnabled,
	tools: cfgHotReloadTools,
	skills: cfgHotReloadSkills,
	extensions: cfgHotReloadExtensions,
	mcpConfig: cfgHotReloadMcpConfig,
	mcpServers: cfgHotReloadMcpServers,
	binary: cfgHotReloadBinary,
});

/**
 * Effective hot-reload switches resolved from the `hotReload.*` settings,
 * gated by the `hotReload.enabled` master switch.
 */
export const cfgHotReload: Derived<HotReloadState> = cfgHotReloadInputs.map(raw => ({
	enabled: raw.enabled,
	tools: raw.enabled && raw.tools,
	skills: raw.enabled && raw.skills,
	extensions: raw.enabled && raw.extensions,
	mcpConfig: raw.enabled && raw.mcpConfig,
	mcpServers: raw.enabled && raw.mcpServers,
	binary: raw.enabled && raw.binary,
}));

export interface HotReloadNotice {
	level: "info" | "warning" | "error";
	message: string;
	source?: string;
}

/**
 * Contract implemented by each hot-reloadable subsystem.
 */
export interface HotReloadSubsystem<TSummary = void> {
	/** Stable subsystem identifier (e.g. `"tools"`, `"skills"`, `"extensions"`, `"mcpConfig"`, `"binary"`). */
	readonly id: string;
	/** Notice source tag passed to `notify` (defaults to `id`). */
	readonly source?: string;
	/** Group key for deduplicating busy-turn deferral notices across related subsystems (defaults to `id`). */
	readonly deferralGroup?: string;
	/** Whether this subsystem should currently be polled (defaults to `() => true`). */
	enabled?: () => boolean;
	/**
	 * Deterministic fingerprint of the subsystem's watched inputs. When the
	 * fingerprint changes from the baseline recorded at `start()`, the subsystem
	 * becomes pending until flushed on idle.
	 */
	signature?: () => Promise<string>;
	/**
	 * Direct reload predicate for subsystems that compare live state against an
	 * external target (such as comparing `process.execPath` to the `omp` binary on `PATH`).
	 * When provided, `start()` polls immediately and `pending` tracks the predicate result.
	 */
	shouldReload?: () => Promise<boolean>;
	/** Applies the reload when idle and optionally returns a structured summary. */
	reload: () => Promise<TSummary>;
	/** Formats a summary returned by `reload()` into a user-facing notice. */
	describe?: (summary: TSummary) => HotReloadNotice | undefined;
	/** Message emitted once per `deferralGroup` when a change is detected while a turn is in flight. */
	deferredMessage?: string;
	/** Prefix for uncaught errors from `reload()` (defaults to `"${id} hot reload failed"`). */
	errorPrefix?: string;
	/** Stops the coordinator before invoking `reload()` (used by process `exec` binary reload). */
	stopBeforeReload?: boolean;
}

export interface HotReloadCoordinatorOptions {
	/** Initial subsystems to register. Additional subsystems may be added with {@link HotReloadCoordinator.register}. */
	subsystems?: ReadonlyArray<HotReloadSubsystem<any>>;
	/** Whether a turn is in flight. */
	isBusy: () => boolean;
	/** Subscribe to the session settling idle; returns the unsubscribe callback. */
	onIdle: (listener: () => void) => () => void;
	/** Emits a user-visible notice. */
	notify: (level: "info" | "warning" | "error", message: string, source?: string) => void;
	/** Poll period. Default 2000 ms. */
	pollIntervalMs?: number;
}

interface SubsystemSlot {
	readonly subsystem: HotReloadSubsystem<any>;
	signature: string | undefined;
	pending: boolean;
}

/**
 * Coordinates polling, signature diffing, busy-turn deferral, and serialized
 * reload execution across all registered {@link HotReloadSubsystem} instances.
 */
export class HotReloadCoordinator {
	readonly #options: HotReloadCoordinatorOptions;
	readonly #slots = new Map<string, SubsystemSlot>();
	readonly #announcedDeferralGroups = new Set<string>();
	#active = false;
	#timer: Timer | undefined;
	#unsubscribeIdle: (() => void) | undefined;
	#working: Promise<void> = Promise.resolve();

	constructor(options: HotReloadCoordinatorOptions) {
		this.#options = options;
		if (options.subsystems) {
			for (const subsystem of options.subsystems) {
				this.#slots.set(subsystem.id, { subsystem, signature: undefined, pending: false });
			}
		}
	}

	/** IDs of all currently registered subsystems in registration order. */
	get subsystemIds(): string[] {
		return [...this.#slots.keys()];
	}

	/**
	 * Registers a hot-reloadable subsystem and returns an unregister callback.
	 * If the coordinator is already active and the subsystem is enabled, its
	 * baseline signature is primed immediately.
	 */
	register<TSummary = void>(subsystem: HotReloadSubsystem<TSummary>): () => void {
		const slot: SubsystemSlot = { subsystem, signature: undefined, pending: false };
		this.#slots.set(subsystem.id, slot);
		if (this.#active && this.#isEnabled(subsystem)) {
			void this.#serialized(async () => {
				if (!this.#active || this.#slots.get(subsystem.id) !== slot || !this.#isEnabled(subsystem)) return;
				if (subsystem.signature && slot.signature === undefined) {
					slot.signature = await subsystem.signature();
				} else if (subsystem.shouldReload) {
					slot.pending = await subsystem.shouldReload();
					await this.#flush();
				}
			});
		}
		return () => {
			this.#slots.delete(subsystem.id);
		};
	}

	#isEnabled(subsystem: HotReloadSubsystem<any>): boolean {
		return subsystem.enabled ? subsystem.enabled() : true;
	}

	#anyEnabled(): boolean {
		for (const slot of this.#slots.values()) {
			if (this.#isEnabled(slot.subsystem)) return true;
		}
		return false;
	}

	/**
	 * Records baselines for enabled signature-based subsystems and starts polling.
	 * Subsystems with `shouldReload` run an initial poll immediately.
	 */
	async start(): Promise<void> {
		if (this.#active) return;
		this.#active = true;
		let hasPredicateSubsystem = false;
		for (const slot of this.#slots.values()) {
			if (!this.#isEnabled(slot.subsystem)) {
				slot.signature = undefined;
				slot.pending = false;
				continue;
			}
			if (slot.subsystem.shouldReload) {
				hasPredicateSubsystem = true;
			}
			if (slot.subsystem.signature) {
				const baseline = await slot.subsystem.signature();
				if (!this.#active) return;
				slot.signature = baseline;
			}
		}
		if (!this.#active) return;
		const interval = this.#options.pollIntervalMs ?? DEFAULT_HOT_RELOAD_POLL_MS;
		this.#timer = setInterval(() => void this.poll(), interval);
		this.#timer.unref?.();
		this.#unsubscribeIdle = this.#options.onIdle(() => void this.#serialized(() => this.#flush()));
		if (hasPredicateSubsystem) {
			await this.poll();
		}
	}

	/** Stops polling and clears all pending reload state. */
	stop(): void {
		this.#active = false;
		this.#announcedDeferralGroups.clear();
		for (const slot of this.#slots.values()) {
			slot.signature = undefined;
			slot.pending = false;
		}
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = undefined;
		this.#unsubscribeIdle?.();
		this.#unsubscribeIdle = undefined;
	}

	/**
	 * Reconciles the coordinator with live setting changes: stops polling when
	 * every subsystem is disabled, starts when at least one is enabled, and primes
	 * baselines for newly enabled subsystems.
	 */
	async sync(): Promise<void> {
		if (!this.#anyEnabled()) {
			this.stop();
			return;
		}
		if (!this.#active) {
			await this.start();
			return;
		}
		await this.#serialized(async () => {
			if (!this.#active) return;
			for (const slot of this.#slots.values()) {
				if (!this.#isEnabled(slot.subsystem)) {
					slot.signature = undefined;
					slot.pending = false;
				} else if (slot.subsystem.signature && slot.signature === undefined) {
					slot.signature = await slot.subsystem.signature();
				}
			}
		});
	}

	/** One poll across all registered subsystems; reloads any that changed once idle. */
	poll(): Promise<void> {
		return this.#serialized(async () => {
			if (!this.#active) return;
			for (const slot of this.#slots.values()) {
				const { subsystem } = slot;
				if (!this.#isEnabled(subsystem)) {
					slot.signature = undefined;
					slot.pending = false;
					continue;
				}
				if (subsystem.shouldReload) {
					slot.pending = await subsystem.shouldReload();
					if (!slot.pending) {
						this.#clearDeferralGroupIfIdle(subsystem.deferralGroup ?? subsystem.id);
					}
				} else if (subsystem.signature) {
					const next = await subsystem.signature();
					if (slot.signature === undefined) {
						slot.signature = next;
					} else if (next !== slot.signature) {
						slot.signature = next;
						slot.pending = true;
					}
				}
			}
			await this.#flush();
		});
	}

	/** Immediately runs `reload()` for all (or the specified) registered subsystems and updates their baselines. */
	reloadNow(ids?: readonly string[]): Promise<void> {
		const filter = ids ? new Set(ids) : undefined;
		return this.#serialized(async () => {
			for (const slot of this.#slots.values()) {
				if (filter && !filter.has(slot.subsystem.id)) continue;
				await this.#executeSlot(slot);
				if (slot.subsystem.signature && this.#isEnabled(slot.subsystem)) {
					slot.signature = await slot.subsystem.signature();
				}
			}
		});
	}

	#clearDeferralGroupIfIdle(group: string): void {
		for (const slot of this.#slots.values()) {
			if (slot.pending && (slot.subsystem.deferralGroup ?? slot.subsystem.id) === group) {
				return;
			}
		}
		this.#announcedDeferralGroups.delete(group);
	}

	#serialized(work: () => Promise<void>): Promise<void> {
		const next = this.#working.then(work, work);
		this.#working = next.catch(() => {});
		return next.catch(() => {});
	}

	async #flush(): Promise<void> {
		if (!this.#active) return;
		const pendingSlots: SubsystemSlot[] = [];
		for (const slot of this.#slots.values()) {
			if (slot.pending && this.#isEnabled(slot.subsystem)) {
				pendingSlots.push(slot);
			}
		}
		if (pendingSlots.length === 0) return;

		if (this.#options.isBusy()) {
			for (const slot of pendingSlots) {
				const { subsystem } = slot;
				const group = subsystem.deferralGroup ?? subsystem.id;
				if (!this.#announcedDeferralGroups.has(group)) {
					this.#announcedDeferralGroups.add(group);
					const message =
						subsystem.deferredMessage ?? `${subsystem.id} changed; reload deferred until the current turn ends`;
					this.#options.notify("info", message, subsystem.source ?? subsystem.id);
				}
			}
			return;
		}

		this.#announcedDeferralGroups.clear();
		for (const slot of pendingSlots) {
			slot.pending = false;
		}
		for (const slot of pendingSlots) {
			if (slot.subsystem.stopBeforeReload) {
				this.stop();
			}
			await this.#executeSlot(slot);
		}
	}

	async #executeSlot(slot: SubsystemSlot): Promise<void> {
		const { subsystem } = slot;
		const source = subsystem.source ?? subsystem.id;
		try {
			const summary = await subsystem.reload();
			if (summary !== undefined && subsystem.describe) {
				const notice = subsystem.describe(summary);
				if (notice) {
					this.#options.notify(notice.level, notice.message, notice.source ?? source);
				}
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			const prefix = subsystem.errorPrefix ?? `${subsystem.id} hot reload failed`;
			this.#options.notify("error", `${prefix}: ${reason}`, source);
		}
	}
}
