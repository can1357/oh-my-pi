/**
 * In-memory usage counts mirrored into agent.db's `<kind>_usage` tables (see
 * {@link AgentStorage.recordUsage}), read synchronously on hot UI paths.
 *
 * - {@link commandUsage}: keyed by canonical slash-command name (builtin primary
 *   name, `skill:<name>`, custom/file/template name). {@link InputController}
 *   records every submitted known command; `CombinedAutocompleteProvider` uses
 *   the counts to break text-match-score ties.
 * - {@link hintUsage}: keyed by composer hint id; a hint retires once its
 *   gesture has been used often enough (see `COMPOSER_HINTS`).
 *
 * Until {@link UsageCounter.load} resolves, hits stay in memory only —
 * headless paths and tests that never load a counter never open agent.db.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { ComposerHintId } from "@oh-my-pi/pi-tui/prompt/composer-hints";
import { AgentStorage, type UsageKind } from "../session/agent-storage";

/** Process-wide use counts for one {@link UsageKind}, keyed by `Name`. */
export class UsageCounter<Name extends string = string> {
	#counts: Record<string, number> = {};
	#storage: AgentStorage | undefined;
	#loadPromise: Promise<void> | undefined;

	constructor(readonly kind: UsageKind) {}

	/** Load persisted counts once per process; concurrent calls share one read. */
	load(): Promise<void> {
		this.#loadPromise ??= (async () => {
			try {
				const opened = await AgentStorage.open();
				const persisted = opened.listUsage(this.kind);
				// Keep hits recorded while the load was in flight.
				for (const name in this.#counts) persisted[name] = (persisted[name] ?? 0) + this.#counts[name]!;
				this.#counts = persisted;
				this.#storage = opened;
			} catch (err) {
				logger.warn("Failed to load usage counts", { kind: this.kind, error: String(err) });
			}
		})();
		return this.#loadPromise;
	}

	get(name: Name): number {
		return this.#counts[name] ?? 0;
	}

	/** Increment a count; persists when the counter is loaded. */
	record(name: Name): void {
		this.#counts[name] = (this.#counts[name] ?? 0) + 1;
		this.#storage?.recordUsage(this.kind, name);
	}
}

/** Slash-command invocation counts. */
export const commandUsage = new UsageCounter("command");

/** Composer hint gesture counts. */
export const hintUsage = new UsageCounter<ComposerHintId>("hint");
