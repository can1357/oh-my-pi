/**
 * Session-scoped manager for agent output IDs.
 *
 * Keeps every subagent output id unique within a session without polluting the
 * common case with bookkeeping. With cross-instance messaging enabled, digit-only
 * names get an `Agent` prefix to distinguish them from PIDs. Repeated names get a
 * numeric suffix (e.g. "Anna", "Anna-2", "Anna-3"). With a parent prefix, ids
 * are nested under it (e.g. "Anna.Bob") so hierarchical outputs stay grouped.
 *
 * This enables reliable agent:// URL resolution and prevents artifact
 * collisions across repeated or nested task invocations.
 */
import * as fs from "node:fs/promises";
import { ADVISOR_TRANSCRIPT_STEM } from "../advisor/transcript-recorder";
import type { Settings } from "../config/settings";
import { cfgTaskCrossInstance } from "./settings";
/** HUD expander click target reserved by the allocator so it cannot name a subagent. */
export const PINNED_HUD_TOGGLE_ID = "@omp:toggle-pinned-hud";

/**
 * Manages agent output ID allocation to ensure uniqueness.
 *
 * Repeated allocations of a name get a `-2`, `-3`, … suffix. On resume, scans
 * existing output and child-session files so prior state is never overwritten.
 */
export class AgentOutputManager {
	#initialized = false;
	#initializing: Promise<void> | undefined;
	/** Final ids already handed out, relative to this manager's scope. */
	readonly #taken = new Set<string>();
	readonly #getArtifactsDir: () => string | null;
	readonly #parentPrefix: string | undefined;
	readonly #settings: Settings | undefined;

	constructor(getArtifactsDir: () => string | null, options?: { parentPrefix?: string; settings?: Settings }) {
		this.#getArtifactsDir = getArtifactsDir;
		this.#parentPrefix = options?.parentPrefix;
		this.#settings = options?.settings;
		// Reserve the advisor transcript stem: a subagent allocated this id would
		// write `<id>.jsonl`, clobbering the advisor's `__advisor.jsonl` in the same
		// artifacts dir. Reserving bumps such a request to `__advisor-2`.
		this.#taken.add(ADVISOR_TRANSCRIPT_STEM);
		// Reserve the pinned-HUD toggle sentinel the same way: a colliding agent
		// id would be indistinguishable from the expander row in click routing.
		this.#taken.add(PINNED_HUD_TOGGLE_ID);
	}

	/**
	 * Seed the taken-id set from output files already on disk so a resumed
	 * session never reuses a name that would clobber a prior subagent's output.
	 */
	async #ensureInitialized(): Promise<void> {
		if (this.#initialized) return;
		this.#initializing ??= this.#seedFromDisk();
		await this.#initializing;
		this.#initialized = true;
	}

	async #seedFromDisk(): Promise<void> {
		const dir = this.#getArtifactsDir();
		if (!dir) return;

		let files: string[];
		try {
			files = await fs.readdir(dir);
		} catch {
			return; // Directory doesn't exist yet
		}

		const prefix = this.#parentPrefix ? `${this.#parentPrefix}.` : "";
		for (const file of files) {
			const extension = file.endsWith(".jsonl") ? ".jsonl" : file.endsWith(".md") ? ".md" : undefined;
			if (!extension) continue;
			let rest = file.slice(0, -extension.length);
			if (prefix) {
				if (!rest.startsWith(prefix)) continue;
				rest = rest.slice(prefix.length);
			}
			// Requested ids never contain "."; a dot marks a nested child, so this
			// manager only owns the first segment of whatever remains.
			const dot = rest.indexOf(".");
			const segment = dot === -1 ? rest : rest.slice(0, dot);
			if (segment) this.#taken.add(segment);
		}
	}

	/** Pick the first free name (base, then `base-2`, `base-3`, …) and reserve it. */
	#allocateUnique(id: string): string {
		let candidate = id;
		for (let n = 2; this.#taken.has(candidate); n++) {
			candidate = `${id}-${n}`;
		}
		this.#taken.add(candidate);
		return this.#parentPrefix ? `${this.#parentPrefix}.${candidate}` : candidate;
	}

	/** Reserve final IDs discovered outside the output directory scan. */
	async reserve(ids: Iterable<string>): Promise<void> {
		await this.#ensureInitialized();
		const prefix = this.#parentPrefix ? `${this.#parentPrefix}.` : "";
		for (const id of ids) {
			let rest = id;
			if (prefix) {
				if (!rest.startsWith(prefix)) continue;
				rest = rest.slice(prefix.length);
			}
			const dot = rest.indexOf(".");
			const segment = dot === -1 ? rest : rest.slice(0, dot);
			if (segment) this.#taken.add(segment);
		}
	}

	/**
	 * Allocate a unique ID.
	 *
	 * @param id Requested ID (e.g., "Anna")
	 * @returns Unique ID ("Anna" first, then "Anna-2", "Anna-3", …)
	 */
	async allocate(id: string): Promise<string> {
		await this.#ensureInitialized();
		const usePrefix = /^\d+$/.test(id) && this.#settings && cfgTaskCrossInstance.get(this.#settings);
		return this.#allocateUnique(usePrefix ? `Agent${id}` : id);
	}
}
