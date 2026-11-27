import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { defaultSessionStorage, isStoredFile, type SessionStorage } from "../session/session-storage";
import { type AgentRef, type AgentRegistryApi, MAIN_AGENT_ID } from "./agent-registry";

export interface PersistedScanOptions {
	shouldContinue?: () => boolean;
	hydrateHistory?: boolean;
	/**
	 * When supplied, every (id → sessionFile) pair this scan restores or
	 * confirms as this root's parked ref is recorded here: the narrowest
	 * root-ownership token `ensurePersistedRoster` validates settled latches
	 * against, bounded by this root's own transcript tree.
	 */
	owned?: Map<string, string>;
	/** Storage holding the transcripts; defaults to the configured one. */
	storage?: SessionStorage;
	/** Observe refs already registered from a different root whose transcript is also present in this root. */
	onCopiedRef?: (ref: AgentRef) => void;
}

/**
 * Upper bound on remembered roster latches. Once the bound is reached, only
 * settled entries are forgotten (oldest first), so an in-flight scan is never
 * evicted and a root whose latch was pruned is simply re-scanned on its next
 * ensure call.
 */
const MAX_PERSISTED_ROSTER_LATCHES = 32;

const kPersistedRosterLatches = Symbol("persistedRosterLatches");

/**
 * Failure-tolerant serialization tail for scan bodies. Distinct roots share one
 * process-global registry, so their scans must not interleave: a child
 * basename present in two roots' trees would otherwise be captured as
 * unregistered by both, and whichever registers last would CAS-skip the other,
 * leaving that root with a settled latch that never saw its own transcript.
 * The tail always stores a settled wrapper, so a failed scan can never poison
 * the queue for the next root.
 */
const kPersistedRosterScanTail = Symbol("persistedRosterScanTail");

interface PersistedRosterLatch {
	/** Settles when the root's roster scan finishes (success or logged failure). */
	pending: Promise<void>;
	/** True once `pending` has settled; only settled latches are evictable. */
	settled: boolean;
	/**
	 * Narrowest root-ownership token: every (id → sessionFile) pair this root's
	 * scan restored as a parked ref — registered fresh, replaced from another
	 * root, or confirmed already pointing at this root's own transcript. A
	 * settled latch is reusable only while every recorded ref still matches
	 * registry identity/session; a missing or re-targeted ref means another
	 * root's scan (or a release) moved the id, so this root must be re-scanned.
	 * Rebuilt per scan, the token stays bounded by the root's own transcript
	 * tree — no reverse global map.
	 */
	owned: Map<string, string>;
}

interface RegistryWithPersistedRosterLatches extends AgentRegistryApi {
	[kPersistedRosterLatches]?: Map<string, PersistedRosterLatch>;
	[kPersistedRosterScanTail]?: Promise<void>;
}

/**
 * A settled latch is reusable only while every parked ref its scan restored
 * still matches registry identity/session. A missing ref (released) or one
 * re-targeted at a different session file (superseded by another root's scan)
 * invalidates the latch, forcing a re-scan that restores this root's own
 * transcripts. Refs the scan did not restore are not this root's to police.
 */
function latchOwnershipValid(registry: AgentRegistryApi, owned: Map<string, string>): boolean {
	for (const [id, sessionFile] of owned) {
		const ref = registry.get(id);
		if (!ref || ref.sessionFile !== sessionFile) return false;
	}
	return true;
}

function resolveRootSessionFile(
	registry: AgentRegistryApi,
	storage: SessionStorage,
	hint?: string | null,
): string | undefined {
	const mainFile = registry.get(MAIN_AGENT_ID)?.sessionFile;
	const candidate =
		typeof hint === "string" && hint.endsWith(".jsonl")
			? hint
			: typeof mainFile === "string" && mainFile.endsWith(".jsonl")
				? mainFile
				: undefined;
	if (candidate === undefined) return undefined;
	let current: string = path.resolve(candidate);
	// The climb is unbounded: a subagent can nest arbitrarily deep (there is no
	// fixed depth ceiling in this tree), and stopping early would make parked
	// top-level siblings invisible to deep children.
	for (;;) {
		const parentFile: string = `${path.dirname(current)}.jsonl`;
		// A regular file, as the `Bun.file(...).exists()` this replaced reported:
		// `existsSync` also accepts a directory named `*.jsonl`, which would make
		// the climb mistake it for a parent transcript.
		if (parentFile === current || !isStoredFile(parentFile, storage)) return current;
		current = parentFile;
	}
}

function rosterScanError(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.length <= 200 ? text : `${text.slice(0, 197)}...`;
}

/** Whether `sessionFile` is the root transcript or lives in its artifacts tree. */
export function sessionFileBelongsToRoot(sessionFile: string, rootSessionFile: string): boolean {
	const file = path.resolve(sessionFile);
	const root = path.resolve(rootSessionFile);
	const artifactRoot = root.slice(0, -".jsonl".length);
	return file === root || file.startsWith(`${artifactRoot}${path.sep}`);
}

/**
 * Whether `ref` is an agent of the session whose transcript is `rootSessionFile`: the
 * process-global registry keeps earlier sessions' agents (a `/resume` leaves the last one's
 * behind), whose transcripts sit outside its artifacts tree. File-less refs belong, and so does
 * every ref while there is no root to compare against.
 */
export function isSessionTreeRef(ref: { sessionFile: string | null }, rootSessionFile: string | undefined): boolean {
	return !rootSessionFile || !ref.sessionFile || sessionFileBelongsToRoot(ref.sessionFile, rootSessionFile);
}

/** Keep old parked trees out of a new/current session's model-facing roster. */
export function isCurrentSessionRosterRef(
	ref: { status: string; sessionFile: string | null },
	rootSessionFile: string | undefined,
): boolean {
	if (ref.status !== "parked" || !rootSessionFile || !ref.sessionFile) return true;
	return sessionFileBelongsToRoot(ref.sessionFile, rootSessionFile);
}

/**
 * Restore parked sibling transcripts once per current root session. Scans are
 * latched per root: concurrent calls for the same root share one in-flight
 * scan, while distinct roots stay latched independently but serialize their
 * scan bodies behind a failure-tolerant tail (a child basename shared across
 * roots must be observed as already-registered, never raced unseen). A settled
 * latch is reusable only while every parked ref its scan restored still matches
 * registry identity/session: a shared id another root's scan replaced (or a
 * released ref) invalidates the latch, so returning to this root re-scans
 * through the tail and restores its own transcripts instead of leaving the
 * other root's refs in this roster. The latch
 * cache is bounded by forgetting settled roots oldest-first, so a switch back
 * to an old root re-scans only once its latch was pruned. IO failure degrades
 * roster counts, never task startup, and remains retryable.
 */
export async function ensurePersistedRoster(
	registry: AgentRegistryApi,
	sessionFileHint?: string | null,
	storage: SessionStorage = defaultSessionStorage(),
): Promise<string | undefined> {
	let root: string | undefined;
	try {
		root = resolveRootSessionFile(registry, storage, sessionFileHint);
	} catch (error) {
		logger.warn("Persisted agent roster root resolution failed; using in-memory peers", {
			error: rosterScanError(error),
		});
		return undefined;
	}
	if (!root) return undefined;

	const taggedRegistry = registry as RegistryWithPersistedRosterLatches;
	let latches = taggedRegistry[kPersistedRosterLatches];
	if (!latches) {
		latches = new Map();
		taggedRegistry[kPersistedRosterLatches] = latches;
	}
	const existing = latches.get(root);
	if (existing) {
		await existing.pending;
		if (existing.settled) {
			// A settled latch is reusable only while every parked ref its scan
			// restored still matches registry identity/session. Another root's
			// scan can replace a shared id globally while this root's latch sits
			// settled; reusing the latch then would leave this root's roster
			// pointing at the other root's transcripts. On any missing or
			// re-targeted ref, drop the latch and refresh this root through the
			// same serialized scan tail so its own transcripts win again.
			if (latchOwnershipValid(registry, existing.owned)) return root;
			if (latches.get(root) === existing) latches.delete(root);
			// A concurrent superseded waiter may already have inserted the fresh
			// latch; join it instead of scanning twice.
			const replacement = latches.get(root);
			if (replacement) {
				await replacement.pending;
				return root;
			}
		} else {
			// A failed scan already dropped its own latch; degrade to in-memory
			// peers and let the next call retry.
			return root;
		}
	}
	// Forget settled latches oldest-first once the bound is reached, so a
	// process that visits many roots doesn't accumulate one entry per root.
	// In-flight scans are never evicted: their latch is the single-flight guard.
	if (latches.size >= MAX_PERSISTED_ROSTER_LATCHES) {
		for (const [latchedRoot, latch] of latches) {
			if (latches.size < MAX_PERSISTED_ROSTER_LATCHES) break;
			if (latch.settled) latches.delete(latchedRoot);
		}
	}
	// Chain the scan body behind any other root's in-flight scan (same-root
	// calls never reach here: they joined the latch above). The tail always
	// stores a settled wrapper, so a failed scan settles it and the next root
	// still proceeds.
	const latch: PersistedRosterLatch = { pending: undefined!, settled: false, owned: new Map() };
	const tail = taggedRegistry[kPersistedRosterScanTail] ?? Promise.resolve();
	const scan = tail.then(() =>
		registerPersistedSubagents(registry, root, { hydrateHistory: false, owned: latch.owned, storage }),
	);
	taggedRegistry[kPersistedRosterScanTail] = scan.then(
		() => {},
		() => {},
	);
	latch.pending = scan.then(
		() => {
			const current = latches.get(root);
			if (current) current.settled = true;
		},
		error => {
			// A failed scan drops its latch so the next call retries; the failure
			// itself degrades to in-memory peers, never task startup.
			const current = latches.get(root);
			if (current && current.pending === latch.pending) {
				latches.delete(root);
			} else if (current) {
				current.settled = true;
			}
			logger.warn("Persisted agent roster scan failed; using in-memory peers", {
				rootSessionFile: root,
				error: rosterScanError(error),
			});
		},
	);
	latches.set(root, latch);
	await latch.pending;
	return root;
}

/** Register persisted subagent and advisor transcripts as parked registry refs. */
export async function registerPersistedSubagents(
	registry: AgentRegistryApi,
	sessionFile: string | null | undefined,
	options: PersistedScanOptions = {},
): Promise<void> {
	if (!sessionFile?.endsWith(".jsonl")) return;
	const { scanPersistedSubagents } = await import("./persisted-scan");
	await scanPersistedSubagents(registry, sessionFile, options);
}
