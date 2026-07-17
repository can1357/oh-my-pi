import type { GopkActivitySink } from "@pk-nerdsaver-ai/pi-activity-journal";
import type { BridgeCursorStore } from "./cursor";
import { buildClipDerivative } from "./manifest";
import { DEFAULT_MAXIMUM_IDLE_MS, segmentFramesIntoClips } from "./segmentation";
import type { FrameSegment, ScreenpipeFrameRow } from "./types";

export interface FrameSource {
	fetchRedactedFrames(options: { sinceFrameId: number; limit: number }): Promise<readonly ScreenpipeFrameRow[]>;
}

export interface ScreenpipeBridgeOptions {
	readonly frameSource: FrameSource;
	readonly sink: GopkActivitySink;
	readonly cursorStore: BridgeCursorStore;
	readonly sessionId: string;
	readonly captureRoot: string;
	/** See `BuildClipDerivativeOptions.mediaRoot` — snapshot hashing is disabled when unset. */
	readonly mediaRoot?: string;
	readonly fetchLimit?: number;
	readonly maximumIdleMs?: number;
}

export interface BridgeRunSummary {
	readonly fetchedFrameCount: number;
	/** Sink calls made, including derivatives the sink's own policy then rejected — not ledger-accepted clips. */
	readonly emittedClipCount: number;
	readonly openSegmentCount: number;
	readonly cursorFrameId: number;
}

const DEFAULT_FETCH_LIMIT = 2_000;

/**
 * Polls a local screenpipe instance for newly redacted frames and forwards
 * them to the activity-journal gopk sink. The cursor only ever advances past
 * frames that were emitted in a closed segment, so a segment still open (its
 * newest frame is within the idle window of "now", or it may continue past a
 * full fetch page) is re-fetched whole on the next poll. A frame whose
 * redaction completes only after the cursor has passed it is never emitted —
 * a deliberate trade: re-slicing old frames would mint overlapping clipIds
 * and pollute the ledger with duplicate evidence.
 */
export class ScreenpipeBridge {
	#options: ScreenpipeBridgeOptions;
	#running = false;

	constructor(options: ScreenpipeBridgeOptions) {
		this.#options = options;
	}

	async runOnce(): Promise<BridgeRunSummary> {
		if (this.#running) throw new Error("a bridge run is already in progress");
		this.#running = true;
		try {
			return await this.#poll();
		} finally {
			this.#running = false;
		}
	}

	async #poll(): Promise<BridgeRunSummary> {
		const { frameSource, sink, cursorStore, sessionId, captureRoot, mediaRoot, maximumIdleMs } = this.#options;
		const fetchLimit = this.#options.fetchLimit ?? DEFAULT_FETCH_LIMIT;

		const lastFrameId = await cursorStore.read();
		const frames = await frameSource.fetchRedactedFrames({ sinceFrameId: lastFrameId, limit: fetchLimit });
		if (frames.length === 0)
			return { fetchedFrameCount: 0, emittedClipCount: 0, openSegmentCount: 0, cursorFrameId: lastFrameId };

		const segments = segmentFramesIntoClips(frames, maximumIdleMs !== undefined ? { maximumIdleMs } : {});
		const now = Date.now();
		const idleThresholdMs = maximumIdleMs ?? DEFAULT_MAXIMUM_IDLE_MS;
		// A full page may have cut a device's newest segment mid-activity, so its
		// last segment cannot be proven closed by timestamps alone — hold it open.
		const truncatedLastFrameIds = frames.length === fetchLimit ? lastSegmentFrameIdsByDevice(segments) : undefined;

		let emittedClipCount = 0;
		let openSegmentCount = 0;
		let cursorFrameId = lastFrameId;
		// Frame ids interleave across devices, so a busy device's closed segments
		// can carry the shared cursor past another device's still-open segment.
		// Cap the cursor just before the earliest open frame so those frames stay
		// inside the next poll's fetch window until their segment closes.
		let earliestOpenFrameId = Number.POSITIVE_INFINITY;
		const truncationHeld: FrameSegment[] = [];
		const emit = async (segment: FrameSegment) => {
			const derivative = await buildClipDerivative(segment, {
				sessionId,
				captureRoot,
				...(mediaRoot !== undefined ? { mediaRoot } : {}),
			});
			await sink(derivative);
			emittedClipCount++;
			cursorFrameId = Math.max(cursorFrameId, lastFrameIdOf(segment));
		};
		for (const segment of segments) {
			const truncated = truncatedLastFrameIds?.get(segment.deviceName) === lastFrameIdOf(segment);
			const timeClosed = isSegmentClosed(segment, now, idleThresholdMs);
			if (truncated || !timeClosed) {
				openSegmentCount++;
				earliestOpenFrameId = Math.min(earliestOpenFrameId, firstFrameIdOf(segment));
				if (truncated && timeClosed) truncationHeld.push(segment);
				continue;
			}
			await emit(segment);
		}

		cursorFrameId = Math.min(cursorFrameId, earliestOpenFrameId - 1);
		// Liveness: a backlog segment longer than one fetch page keeps every page
		// full and would be truncation-held forever, freezing the cursor. When a
		// full page yields no cursor progress, emit the time-closed held segments
		// anyway — the split at the page boundary is artificial but produces
		// disjoint clips, whereas holding produces none at all.
		if (cursorFrameId <= lastFrameId && truncationHeld.length > 0) {
			earliestOpenFrameId = Number.POSITIVE_INFINITY;
			for (const segment of segments) {
				if (truncationHeld.includes(segment)) continue;
				if (!isSegmentClosed(segment, now, idleThresholdMs)) {
					earliestOpenFrameId = Math.min(earliestOpenFrameId, firstFrameIdOf(segment));
				}
			}
			// A held segment that reaches into another device's open frame range
			// can't be closed off yet either — emitting it now would still get
			// re-fetched (and re-emitted with an extended, overlapping clipId)
			// once that other segment closes.
			const progressableHeld = truncationHeld.filter(segment => lastFrameIdOf(segment) < earliestOpenFrameId);
			for (const segment of progressableHeld) {
				await emit(segment);
				openSegmentCount--;
			}
			cursorFrameId = Math.min(cursorFrameId, earliestOpenFrameId - 1);
		}

		if (cursorFrameId > lastFrameId) await cursorStore.write(cursorFrameId);
		else cursorFrameId = lastFrameId;
		return { fetchedFrameCount: frames.length, emittedClipCount, openSegmentCount, cursorFrameId };
	}
}

function isSegmentClosed(segment: FrameSegment, now: number, idleThresholdMs: number): boolean {
	return now - Date.parse(segment.window.endedAt) >= idleThresholdMs;
}

function lastFrameIdOf(segment: FrameSegment): number {
	const last = segment.frames[segment.frames.length - 1];
	if (!last) throw new Error("segment must contain at least one frame");
	return last.id;
}

function firstFrameIdOf(segment: FrameSegment): number {
	const first = segment.frames[0];
	if (!first) throw new Error("segment must contain at least one frame");
	return first.id;
}

function lastSegmentFrameIdsByDevice(segments: readonly FrameSegment[]): Map<string, number> {
	const byDevice = new Map<string, number>();
	for (const segment of segments) {
		const lastId = lastFrameIdOf(segment);
		const current = byDevice.get(segment.deviceName);
		if (current === undefined || lastId > current) byDevice.set(segment.deviceName, lastId);
	}
	return byDevice;
}
