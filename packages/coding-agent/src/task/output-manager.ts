/**
 * Session-scoped manager for agent output IDs.
 *
 * Keeps every subagent output id unique within a session without polluting the
 * common case with bookkeeping. A requested name is used verbatim the first
 * time it appears; only a *repeated* name gets a numeric suffix to disambiguate
 * it (e.g. "Anna", "Anna-2", "Anna-3"). When a parent prefix is configured, ids
 * are nested under it (e.g. "Anna.Bob") so hierarchical outputs stay grouped.
 *
 * This enables reliable agent:// URL resolution and prevents artifact
 * collisions across repeated or nested task invocations.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, toError } from "@oh-my-pi/pi-utils";

import {
	abortRejection,
	mintSessionId,
	RESERVED_CLAIMS_FILE,
	whenArtifactCopiesSettle,
} from "../session/session-manager";
import { ADVISOR_TRANSCRIPT_STEM } from "../advisor/transcript-recorder";
/** HUD expander click target reserved by the allocator so it cannot name a subagent. */
export const PINNED_HUD_TOGGLE_ID = "@omp:toggle-pinned-hud";

/**
 * Manages agent output ID allocation to ensure uniqueness.
 *
 * The first allocation of a given name keeps the name as-is; subsequent
 * allocations of the same name get a `-2`, `-3`, … suffix. On resume, scans
 * existing output and child-session files so prior state is never overwritten.
 */
export class AgentOutputManager {
	#initialized = false;
	#initializing: Promise<void> | undefined;
	/** Final ids already handed out, relative to this manager's scope. */
	readonly #taken = new Set<string>();
	readonly #getArtifactsDir: () => string | null;
	readonly #parentPrefix: string | undefined;
	readonly #artifactsSettled: ((signal?: AbortSignal) => Promise<void>) | undefined;
	readonly #reservedNames: (() => readonly string[]) | undefined;
	/** Set when the claims beside the artifacts exist but could not be read. */
	#claimsUnreadable: Error | undefined;

	constructor(
		getArtifactsDir: () => string | null,
		options?: {
			parentPrefix?: string;
			artifactsSettled?: (signal?: AbortSignal) => Promise<void>;
			/** Names the session's transcript already refers to and has no file for. */
			reservedNames?: () => readonly string[];
		},
	) {
		this.#getArtifactsDir = getArtifactsDir;
		this.#parentPrefix = options?.parentPrefix;
		this.#artifactsSettled = options?.artifactsSettled;
		this.#reservedNames = options?.reservedNames;
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
	async #ensureInitialized(signal?: AbortSignal): Promise<void> {
		if (this.#initialized) return;
		// The seeding is shared; the waiting is not. One caller's cancellation
		// is its own: it must not finish another caller's wait, and it must not
		// be remembered as the answer for every allocation that follows.
		const seeding = (this.#initializing ??= this.#seedFromDisk().catch(error => {
			this.#initializing = undefined;
			throw error;
		}));
		if (signal) await Promise.race([seeding, abortRejection(signal)]);
		else await seeding;
		this.#initialized = true;
	}

	async #seedFromDisk(): Promise<void> {
		// A fork's inherited output arrives in the background. Seeding before it
		// lands reads an empty directory, and the first subagent then takes a
		// name the inherited transcript already refers to — and keeps it, since
		// the copy leaves a name the destination already has alone.
		// Names the inherited transcript refers to are taken whether or not
		// their files arrived: waiting for the copy only protects the ones it
		// delivers, and a copy that lost them leaves the references behind.
		for (const name of this.#reservedNames?.() ?? []) this.#taken.add(name);
		await this.#artifactsSettled?.();
		const dir = this.#getArtifactsDir();
		if (!dir) return;
		// Also by directory, for a caller that was handed one without a session.
		await whenArtifactCopiesSettle(dir);
		// The names a session has spent are recorded beside its artifacts,
		// because a name whose file never arrived is invisible to the scan
		// below and a caller handed only a directory has no header to read.
		try {
			const claims = JSON.parse(await fs.readFile(path.join(dir, RESERVED_CLAIMS_FILE), "utf8"));
			if (Array.isArray(claims?.names)) for (const name of claims.names) this.#taken.add(String(name));
		} catch (error) {
			if (!isEnoent(error)) {
				// A record that cannot be read is not a record that says
				// nothing: the one name that must not be handed out wrongly is
				// the one being asked for, so it is treated as spoken for and
				// the caller gets a disambiguated one instead.
				// Not "no claims": no answer. Handing out any name from a
				// directory whose spent names cannot be read is how a new
				// subagent comes to answer for an `agent://` reference the
				// conversation already made.
				this.#claimsUnreadable = toError(error);
			}
		}

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
		if (this.#claimsUnreadable) {
			// The names this session has spent cannot be read, so no suffix can
			// be known to be free — `-2` least of all, since it is the one a
			// previous disambiguation would have taken. A name nothing can
			// already have is the only safe answer; it still goes through the
			// same scoping as any other, so a nested child keeps its parent's
			// prefix.
			//
			// Unguessable is not unique: two mints can end in the same eight
			// characters, and this manager has already handed out everything in
			// `#taken`. Asking it is what keeps one subagent's output from
			// being served as another's.
			for (let attempt = 0; ; attempt++) {
				const tail = mintSessionId().slice(-8);
				const unique = attempt === 0 ? `${id}-${tail}` : `${id}-${tail}-${attempt + 1}`;
				if (this.#taken.has(unique)) continue;
				this.#taken.add(unique);
				return this.#parentPrefix ? `${this.#parentPrefix}.${unique}` : unique;
			}
		}
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
	async allocate(id: string, options?: { signal?: AbortSignal }): Promise<string> {
		await this.#ensureInitialized(options?.signal);
		return this.#allocateUnique(id);
	}
}
