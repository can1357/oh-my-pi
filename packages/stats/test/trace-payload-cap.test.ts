/**
 * Contracts for the trace payload cap: the transport track list is reduced
 * tail-first, the span budget keeps the earliest activity, and child links are
 * cleared when their target track was omitted or emptied.
 */

import { describe, expect, it } from "bun:test";
import { truncateTraceTracks } from "@oh-my-pi/omp-stats/trace";
import type { TraceTrack } from "@oh-my-pi/omp-stats/types";

const T = 1_700_000_000_000;

function syntheticTrack(id: string, spanCount: number): TraceTrack {
	return {
		id,
		parentId: id === "main" ? null : "main",
		label: id,
		agent: null,
		model: null,
		file: `/tmp/${id}.jsonl`,
		spans: Array.from({ length: spanCount }, (_, index) => ({
			id: `${id}:${index}`,
			kind: "model" as const,
			start: T + index,
			end: T + index + 1,
			label: "m-1",
		})),
		markers: [],
	};
}

describe("trace payload cap", () => {
	it("drops trailing tracks first and then the latest spans", () => {
		const tracks = [syntheticTrack("main", 4), syntheticTrack("a", 4), syntheticTrack("b", 4)];
		const truncated = truncateTraceTracks(tracks, 2, 5);
		expect(tracks).toHaveLength(2);
		expect(tracks[0].spans).toHaveLength(4);
		expect(tracks[1].spans).toHaveLength(1);
		expect(truncated).toEqual({ tracks: 1, spans: 7 });
	});

	it("returns undefined when the payload is within budget", () => {
		const tracks = [syntheticTrack("main", 2), syntheticTrack("a", 2)];
		expect(truncateTraceTracks(tracks, 2, 4)).toBeUndefined();
	});

	it("drops child links whose target track was omitted by the track cap", () => {
		const main = syntheticTrack("main", 2);
		main.spans[0].childTrackId = "a";
		main.spans[1].childTrackId = "b";
		const tracks = [main, syntheticTrack("a", 1), syntheticTrack("b", 1)];
		expect(truncateTraceTracks(tracks, 2, 100)).toEqual({ tracks: 1, spans: 1 });
		expect(tracks[0].spans[0].childTrackId).toBe("a");
		expect(tracks[0].spans[1].childTrackId).toBeUndefined();
	});

	it("drops child links whose target track lost every span to the span cap", () => {
		const main = syntheticTrack("main", 2);
		main.spans[0].childTrackId = "a";
		const tracks = [main, syntheticTrack("a", 4)];
		expect(truncateTraceTracks(tracks, 1024, 2)).toEqual({ tracks: 0, spans: 4 });
		expect(tracks[1].spans).toHaveLength(0);
		expect(tracks[0].spans[0].childTrackId).toBeUndefined();
	});
});
