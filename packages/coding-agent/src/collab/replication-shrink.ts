/**
 * Hard-cap helper for host→guest collab frames.
 *
 * The host wraps every {@link CollabFrame} in an AES-GCM envelope and ships it
 * through the relay's WebSocket. WebSocket servers enforce a per-frame
 * `maxPayloadLength` (Bun's default is 16 MB; many proxies cap lower). A
 * single oversized payload — typically a `read`/`bash`/`search` tool result
 * captured as one multi-megabyte string, or a tool result whose `content`
 * array holds thousands of small blocks — would otherwise ship as its own
 * oversized frame and trip that limit, killing the host's WebSocket with
 * `1006 Received too big message`. `CollabSocket` treats 1006 as transient
 * and reconnects, the next guest hello triggers the same oversized send, and
 * the loop never breaks (issue #3739).
 *
 * That ceiling has to be *enforced*, not approached (issue #11433). Three
 * input shapes escaped the previous best-effort version, each reproduced
 * before the fix:
 *
 * - a payload whose size lives in its **object keys** — a single 17 MiB key,
 *   or 200 000 short keys. Keys are identity and can never be truncated, so
 *   every string/array pass returned the payload untouched;
 * - a payload nested past the engine's own serialization limit: the walk
 *   recursed once per level and threw `RangeError: Maximum call stack size
 *   exceeded` out of the `onEntryAppended` chokepoint. Every caller swallows
 *   that throw, so the real symptom was silent: the entry never reached
 *   guests (live path), or a `snapshot-chunk` train ended without its
 *   `final: true` terminator and the guest's join timed out while the host
 *   still listed it as joined (snapshot path);
 * - a CJK-heavy payload, because the cap was compared against
 *   `JSON.stringify(...).length` — UTF-16 code units, up to 3x under the
 *   bytes the relay would see.
 *
 * The shape-preserving passes still run first: keeping the wire shape is what
 * carries discriminators and ids to the guest. What survives them is replaced
 * by a *typed placeholder*, because bounding the bytes at that point means
 * abandoning the payload by definition:
 *
 * - a session entry becomes a `custom_message` that keeps the original
 *   `id`/`parentId`/`timestamp`, so the guest's branch chain stays connected
 *   and the loss is visible in the replica instead of silent;
 * - an agent event becomes a `notice`, which by contract never enters agent
 *   state and never reaches the model.
 *
 * Nothing trimmed is lost, only deferred (issue #9469): every clipped string,
 * clipped array and whole-entry placeholder is listed in the entry's
 * `collabElided` with its path into the *original* entry, the UTF-8 size and
 * {@link collabValueHash} of the original value's JSON. The host keeps the
 * original in memory, so a guest can fetch the full value by that path and the
 * host can refuse it as stale when the hash no longer matches.
 */

import {
	COLLAB_ENTRY_OMITTED_CUSTOM_TYPE,
	type CollabElided,
	type SessionEntry as WireSessionEntry,
} from "@oh-my-pi/pi-wire";
import type { AgentSessionEvent } from "../session/agent-session";
import type { SessionEntry } from "../session/session-entries";
import { collabValueHash, elidedOriginals, placeholdImagesForReplication } from "./replication-images";

/**
 * Per-payload ceiling for host→guest frames. Bun's default WebSocket
 * `maxPayloadLength` is 16 MB; we leave a generous margin so the AES-GCM
 * envelope (+ IV + tag), the 4-byte peer header, and the outer wire wrapper
 * fit comfortably under that on every reasonable relay.
 */
export const MAX_REPLICATED_PAYLOAD_BYTES = 1 * 1024 * 1024;

/**
 * A session entry the guest's wire grammar can represent — what the host has
 * after filtering on `isWireSessionEntry`. Both bounds preserve it: the
 * placeholder is a `custom_message`, which is a member of the host union and
 * of the wire skeleton alike, so the guest's renderer and replica loader keep
 * treating the frame as a normal entry.
 */
export type ReplicatedEntry = SessionEntry & WireSessionEntry;

/**
 * Deepest nesting the walk emits.
 *
 * The engine, not this helper, is the limit being defended: measured on Bun,
 * `JSON.stringify` and `structuredClone` both throw `RangeError` at roughly
 * 40 000 levels, and every consumer serializes a replicated payload again —
 * the host seals frames through `JSON.stringify` (crypto.ts), the guest
 * writes the replica as JSONL (guest.ts). 1 000 keeps a 40x margin under the
 * engine limit while staying far above any real entry (they nest a handful of
 * levels). Deeper payloads are elided with a marker rather than dropped, so
 * ids and shallow metadata still reach the guest.
 */
export const MAX_REPLICATED_DEPTH = 1000;

/**
 * Progressive shrink passes. Each pass tightens both the per-string cap and
 * the per-array head limit; the loop stops at the first pass whose output
 * fits {@link MAX_REPLICATED_PAYLOAD_BYTES}. The schedule is concrete (not
 * recomputed) so the failure modes the helper guards against are visible:
 *
 * - One giant string → the first pass already truncates it under 64 KB.
 * - Array of many small blocks (e.g. a tool result with thousands of
 *   `{type:"text", text:"..."}` content items) → later passes head-clip the
 *   array to a small sample with a `[…N items elided]` summary element.
 *
 * The final pass clamps every string to 64 B and every array to one element.
 * Payloads that still exceed the ceiling after it are handled by the typed
 * placeholders in {@link shrinkReplicatedEntry} / {@link shrinkReplicatedEvent}.
 */
interface ShrinkPass {
	stringCap: number;
	arrayLimit: number;
}

const SHRINK_PASSES: readonly ShrinkPass[] = [
	{ stringCap: 64 * 1024, arrayLimit: 256 },
	{ stringCap: 16 * 1024, arrayLimit: 128 },
	{ stringCap: 4 * 1024, arrayLimit: 64 },
	{ stringCap: 1 * 1024, arrayLimit: 32 },
	{ stringCap: 256, arrayLimit: 16 },
	{ stringCap: 256, arrayLimit: 4 },
	{ stringCap: 64, arrayLimit: 1 },
];

const STRING_ELISION_RESERVE = 80;
const DEPTH_ELISION_MARKER = "…[deeper levels elided for collab session]";
const CYCLE_ELISION_MARKER = "…[cyclic reference elided for collab session]";

/**
 * Most `collabElided` records one entry carries. Past it the list collapses to
 * a single entry-level record: fetching the whole original entry recovers every
 * trimmed value at once, and the metadata stays small next to the ceiling.
 */
const MAX_ELIDED_RECORDS = 64;

/** A value one shrink pass trimmed; hashed only if that pass is the one shipped. */
interface ElisionSite {
	/** Path into the object the pass walked; `elisionRecord` maps it onto the original entry. */
	path: (string | number)[];
	kind: "string" | "array";
}

/** `JSON.stringify` replacer that serializes {@link elidedOriginals} keys as their originals. */
const restoreElidedOriginals = (_key: string, value: unknown): unknown =>
	typeof value === "object" && value !== null ? (elidedOriginals.get(value) ?? value) : value;

/**
 * Describe the original value behind `walkedPath` — a path into `walked`, the
 * object the passes walked — or `undefined` when it cannot be serialized: the
 * host could not serve it either, so no record is better than one that always
 * fails.
 *
 * The value is resolved on `source` (the entry as the caller holds it), never
 * on a bounded copy: that copy is depth-limited and cycle-free, so a value
 * holding an elided branch would hash differently from what the host serves.
 * The recorded path addresses the original entry: an image-only array that
 * lost its images ({@link elidedOriginals}) shifted its later elements down,
 * so indices into it are mapped back.
 */
function elisionRecord(
	walked: unknown,
	source: unknown,
	walkedPath: readonly (string | number)[],
	kind: CollabElided["kind"],
	restore: boolean,
): CollabElided | undefined {
	const path: (string | number)[] = [];
	let json: string | undefined;
	try {
		let at = walked;
		let value = source;
		for (const key of walkedPath) {
			let originalKey = key;
			const removal = typeof key === "number" ? elidedOriginals.get(at as object) : undefined;
			if (Array.isArray(removal)) {
				// Removal kept every other element in order: the `key`-th survivor
				// is the `key`-th match walking the original.
				const kept = at as unknown[];
				let survivor = 0;
				for (originalKey = 0; originalKey < removal.length; originalKey++) {
					if (removal[originalKey] !== kept[survivor]) continue;
					if (survivor === key) break;
					survivor++;
				}
			}
			path.push(originalKey);
			at = (at as Record<string | number, unknown>)[key];
			// When `source` is the walked object itself, step into its original.
			const original = elidedOriginals.get(value as object);
			value = ((Array.isArray(original) ? original : value) as Record<string | number, unknown>)[originalKey];
		}
		json = restore ? JSON.stringify(value, restoreElidedOriginals) : JSON.stringify(value);
	} catch {
		return undefined;
	}
	if (json === undefined) return undefined;
	return { path, kind, bytes: Buffer.byteLength(json, "utf8"), hash: collabValueHash(json) };
}

/**
 * UTF-8 byte length of `value`'s JSON form — the metric the relay actually
 * enforces, and therefore the only one this module compares against the
 * ceiling. `codePointLength`/`String#length` are UTF-16 code units and
 * under-count non-ASCII payloads by up to 3x.
 *
 * Returns `null` when the value cannot be serialized at all (cyclic, `BigInt`,
 * or nested past the engine's own recursion limit). Callers treat `null` as
 * "definitely over the ceiling" — that is what routes a pathological payload
 * into the placeholder path instead of shipping it.
 */
export function replicationByteLength(value: unknown): number | null {
	try {
		const json = JSON.stringify(value);
		return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
	} catch {
		return null;
	}
}

/** True when `value` is measurable and already under the ceiling. */
function fitsUnderCeiling(value: unknown): boolean {
	const bytes = replicationByteLength(value);
	return bytes !== null && bytes <= MAX_REPLICATED_PAYLOAD_BYTES;
}

/**
 * Head-truncate one string leaf to `stringCap`, appending a marker that
 * reports the exact number of dropped characters so a guest can tell "this
 * was bigger". Strings that already fit are returned by reference.
 */
function clipString(value: string, stringCap: number): string {
	if (value.length <= stringCap) return value;
	const headLen = Math.max(0, stringCap - STRING_ELISION_RESERVE);
	return `${value.slice(0, headLen)}\n…[${value.length - headLen} chars elided for collab session]`;
}

/**
 * One container being rebuilt. Entries are visited one key per loop tick, so
 * the stack holds one frame per *nesting level* — never one per sibling —
 * which is what keeps a 200 000-key object from allocating 200 000 frames.
 */
interface WalkFrame {
	src: Record<string | number, unknown>;
	dst: Record<string | number, unknown>;
	keys: readonly (string | number)[];
	depth: number;
	index: number;
	/**
	 * Dictionary destination: keys must be defined explicitly (PR #11999
	 * review) — a plain-assignment `dst[key]` on a `{}` destination routes an
	 * own `__proto__` key through the inherited setter, mutating the clone's
	 * prototype and silently dropping persisted extension metadata.
	 */
	safe: boolean;
}

/**
 * Rebuild `value` as a fresh clone with long strings head-truncated, long
 * array tails head-clipped, and nesting past {@link MAX_REPLICATED_DEPTH}
 * elided. Iterative by construction: recursion is what used to turn a deep
 * entry into a `RangeError` instead of an oversized payload.
 */
function shrinkWalk(root: unknown, stringCap: number, arrayLimit: number, sites?: ElisionSite[]): unknown {
	const stack: WalkFrame[] = [];
	// Containers on the current path. The previous recursive walk threw on a
	// cycle; an iterative walk would instead loop forever, so a repeated
	// ancestor degrades to a marker.
	const ancestors = new WeakSet<object>();

	const visit = (value: unknown, depth: number): unknown => {
		// A trim's path is every open frame's current key; it is built only when
		// a trim fires, so the walk itself stays allocation-free.
		if (typeof value === "string") {
			if (sites && value.length > stringCap) {
				sites.push({ path: stack.map(frame => frame.keys[frame.index - 1] as string | number), kind: "string" });
			}
			return clipString(value, stringCap);
		}
		if (value === null || typeof value !== "object") return value;
		if (depth >= MAX_REPLICATED_DEPTH) return DEPTH_ELISION_MARKER;
		if (ancestors.has(value)) return CYCLE_ELISION_MARKER;

		if (Array.isArray(value)) {
			const keep = Math.min(value.length, arrayLimit);
			const elided = value.length - keep;
			// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
			const out: unknown[] = new Array(elided > 0 ? keep + 1 : keep);
			if (elided > 0) {
				out[keep] = `…[${elided} items elided for collab session]`;
				// Recorded before this array's frame is pushed, so the path ends at
				// the array itself; kept items keep their original indices.
				sites?.push({ path: stack.map(frame => frame.keys[frame.index - 1] as string | number), kind: "array" });
			}
			if (keep > 0) {
				ancestors.add(value);
				// An array frame's keys are simply its surviving indices; the list
				// is bounded by `arrayLimit`, never by the array's own length.
				const keys = Array.from({ length: keep }, (_, i) => i);
				stack.push({
					src: value as unknown as Record<string | number, unknown>,
					dst: out as unknown as Record<string | number, unknown>,
					keys,
					depth: depth + 1,
					index: 0,
					safe: false,
				});
			}
			return out;
		}

		const src = value as Record<string, unknown>;
		const withToJSON = value as { toJSON?: (key?: string) => unknown };
		if (typeof withToJSON.toJSON === "function") {
			// Own `toJSON` is honored before the walk: `JSON.stringify` calls it
			// for the replica JSONL and the sealed wire frame, so the copy must
			// reflect it — emitting `{}` (a Date's own-key view) would silently
			// corrupt extension metadata that `structuredClone` preserved
			// (PR #11999 review). The bound method ships as a leaf pair, so the
			// serialized clone exactly matches what `stringify` would emit.
			return { toJSON: withToJSON.toJSON.bind(value) };
		}
		// `Object.keys` (not `for…in`) so the clone matches what
		// `JSON.stringify` will actually emit — inherited keys are not part of
		// the serialized payload in the first place. Dictionary destination:
		// an own `__proto__` key must survive as data (PR #11999 review).
		const keys = Object.keys(src);
		const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
		if (keys.length > 0) {
			ancestors.add(value);
			stack.push({
				src,
				dst: out as unknown as Record<string | number, unknown>,
				keys,
				depth: depth + 1,
				index: 0,
				safe: true,
			});
		}
		return out;
	};

	const result = visit(root, 0);
	while (stack.length > 0) {
		const frame = stack[stack.length - 1];
		if (!frame) break;
		if (frame.index >= frame.keys.length) {
			stack.pop();
			ancestors.delete(frame.src);
			continue;
		}
		const key = frame.keys[frame.index++];
		if (key === undefined) continue;
		const child = visit(frame.src[key], frame.depth);
		if (frame.safe) {
			// Explicit define (never a plain assignment): keeps own `__proto__`
			// keys as data on the null-prototype destination.
			Object.defineProperty(frame.dst, key, {
				value: child,
				writable: true,
				enumerable: true,
				configurable: true,
			});
		} else {
			frame.dst[key] = child;
		}
	}
	return result;
}

/**
 * Deep-copy `value` under the same depth bound the shrink passes use, without
 * clipping a single string or array.
 *
 * This is the copier the host hands to `SessionManager.snapshotForReplication`.
 * The default there is `structuredClone`, which throws `RangeError` on a payload
 * nested past the engine's recursion limit — and that throw lands inside the
 * host's hello handler, *before* {@link shrinkReplicatedEntry} gets the chance
 * to bound the offending entry, so the joining guest never receives its
 * `final` chunk (issue #11433). Copying through the walk instead degrades only
 * the too-deep branch, and the entry still arrives with its `id`/`parentId`
 * intact.
 *
 * Bounded, not lossless: nesting past {@link MAX_REPLICATED_DEPTH} and repeated
 * ancestors become markers, exactly as in the shrink passes. Session entries are
 * JSON by construction (persisted as JSONL, shipped as JSON), so the walk's
 * container handling is not a narrowing for the values the host copies through
 * it: own `__proto__` keys survive as data (dictionary destinations) and own
 * `toJSON` methods are honored, matching what `JSON.stringify` emits for the
 * replica JSONL and the sealed wire frame (PR #11999 review).
 */
export function copyForReplication<T>(value: T): T {
	return shrinkWalk(value, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY) as T;
}

/**
 * Best-effort shape-preserving shrink: long strings head-truncated, long
 * array tails head-clipped, nesting past {@link MAX_REPLICATED_DEPTH} elided.
 *
 * Returns `value` itself when it already fits. May still exceed
 * {@link MAX_REPLICATED_PAYLOAD_BYTES} when the size lives in object keys —
 * keys are identity and nothing here may drop them — which is why
 * {@link shrinkReplicatedEvent} owns the ceiling guarantee.
 */
function shrinkPayloadShape<T>(value: T): T {
	if (fitsUnderCeiling(value)) return value;
	let shrunk: unknown = value;
	for (const pass of SHRINK_PASSES) {
		shrunk = shrinkWalk(value, pass.stringCap, pass.arrayLimit);
		if (fitsUnderCeiling(shrunk)) return shrunk as T;
	}
	return shrunk as T;
}

/** Describe a payload that could not be shrunk, for the guest-facing marker. */
function omittedDetail(type: string, bytes: number | null): string {
	return bytes === null ? `${type} entry` : `${type} entry, ${bytes} bytes`;
}

/**
 * Bound one replicated session entry under
 * {@link MAX_REPLICATED_PAYLOAD_BYTES}.
 *
 * Shrinking is shape-preserving whenever it can be. When it cannot — size in
 * the keys, or a payload that is not serializable at all — the entry is
 * replaced by a `custom_message` that keeps `id`/`parentId`/`timestamp`, so
 * the guest's branch chain stays connected and the substitution is visible in
 * the replica. A `custom_message` is the carrier because the guest's live
 * entry path only special-cases `message`/`compaction`/`branch_summary`, and
 * because it survives the replica JSONL load that the snapshot path performs.
 *
 * The snapshot path loads the replica through the normal session machinery, so
 * on that path the placeholder does reach the guest's model context. That is
 * deliberate: the guest's model is told the content was dropped instead of
 * silently reasoning over a gap in the transcript.
 *
 * Images go first: an oversized entry is copied and its images taken out
 * (`placeholdImagesForReplication`: text placeholders, or removal from
 * image-only arrays), so a screenshot ships as a `kind: "image"` record rather
 * than as clipped base64.
 * If the copy still does not fit, the passes run on it. Every trim is listed in
 * `collabElided` (see the module doc): the records of the pass actually
 * shipped, after any records the entry already carried and the image records,
 * which ship verbatim and are never walked. Hashes are taken from `entry`
 * itself, never from the bounded copy. The placeholder carries one
 * entry-level record plus `details: { omittedType, bytes }`. The ceiling is
 * measured with the records attached. `entry` is never mutated: the live path
 * passes the session's own object.
 *
 * Typed on the host's own entry union rather than the wire skeleton: the
 * frame carries the rich entry and only *serializes* into the wire shape.
 *
 * Never throws: it is called from the `onEntryAppended` chokepoint, whose
 * caller swallows exceptions, and from the snapshot chunker, where a throw
 * would strand the guest without a `final` chunk.
 */
export function shrinkReplicatedEntry(entry: ReplicatedEntry): ReplicatedEntry {
	if (fitsUnderCeiling(entry)) return entry;
	const { collabElided: inputRecords = [], ...source } = entry;
	// Input records mean the caller already took the images out of its own
	// detached copy: walk it as is, and hash with the originals put back.
	const restore = inputRecords.length > 0;
	let entryRecord: CollabElided | undefined;
	let entryRecordDone = false;
	const wholeEntryRecord = (): CollabElided | undefined => {
		if (!entryRecordDone) {
			entryRecordDone = true;
			entryRecord = elisionRecord(source, source, [], "entry", restore);
		}
		return entryRecord;
	};

	const copy = restore ? undefined : copyForReplication(entry);
	if (copy && placeholdImagesForReplication(copy) > 0 && fitsUnderCeiling(copy)) return copy;
	const { collabElided: prior = [], ...body } = copy ?? entry;

	const sites: ElisionSite[] = [];
	for (const pass of SHRINK_PASSES) {
		sites.length = 0;
		const shrunk = shrinkWalk(body, pass.stringCap, pass.arrayLimit, sites) as ReplicatedEntry;
		if (!fitsUnderCeiling(shrunk)) continue;
		if (prior.length + sites.length === 0) return shrunk;

		let whole = prior.length + sites.length > MAX_ELIDED_RECORDS ? wholeEntryRecord() : undefined;
		if (whole) {
			shrunk.collabElided = [whole];
		} else {
			// Within the cap, or an unserializable entry that has no entry-level
			// record to collapse to: list what can be hashed, up to the cap.
			const records = prior.slice(0, MAX_ELIDED_RECORDS);
			for (const site of sites) {
				if (records.length >= MAX_ELIDED_RECORDS) break;
				const record = elisionRecord(body, source, site.path, site.kind, restore);
				if (record) records.push(record);
			}
			if (records.length > 0) shrunk.collabElided = records;
		}
		if (fitsUnderCeiling(shrunk)) return shrunk;
		// A list outgrows the ceiling when its paths run through huge keys; the
		// entry-level record is fixed-size.
		whole ??= wholeEntryRecord();
		if (whole) {
			shrunk.collabElided = [whole];
			if (fitsUnderCeiling(shrunk)) return shrunk;
		}
	}

	const whole = wholeEntryRecord();
	const bytes = whole?.bytes ?? null;
	const placeholder: ReplicatedEntry = {
		type: "custom_message",
		id: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		customType: COLLAB_ENTRY_OMITTED_CUSTOM_TYPE,
		display: true,
		content: `…[${omittedDetail(entry.type, bytes)} omitted for collab session: too large to replicate]`,
		details: bytes === null ? { omittedType: entry.type } : { omittedType: entry.type, bytes },
	};
	if (whole) placeholder.collabElided = [whole];
	return placeholder;
}

/**
 * Emit the guest-visible notice that accompanies a live oversized-entry
 * substitution. Mirrors the wording of the placeholder so a guest that only
 * applies `message` entries to its live agent context still learns an entry
 * was dropped (PR #11999 review) — notices never enter agent state and never
 * reach the model, so this is display-only.
 */
export function oversizedEntryNotice(entryType: string): Extract<AgentSessionEvent, { type: "notice" }> {
	return {
		type: "notice",
		level: "warning",
		source: "collab",
		message: `Host entry omitted: too large to replicate (${entryType}).`,
	};
}

/**
 * Bound one replicated agent event under {@link MAX_REPLICATED_PAYLOAD_BYTES}.
 *
 * Events carry no identity to preserve, so an event that survives the
 * shape-preserving passes is replaced by a `notice` naming the omitted type —
 * notices never enter agent state and never reach the model, which keeps the
 * substitution out of the guest's context instead of silently diverging from
 * the host's view.
 */
export function shrinkReplicatedEvent(event: AgentSessionEvent): AgentSessionEvent {
	const shrunk = shrinkPayloadShape(event);
	if (fitsUnderCeiling(shrunk)) return shrunk;
	return {
		type: "notice",
		level: "warning",
		source: "collab",
		message: `Host event omitted: too large to replicate (${event.type}).`,
	};
}
