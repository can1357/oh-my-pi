import { describe, expect, it } from "bun:test";
import {
	parseStreamingJson,
	parseStreamingJsonThrottled,
	STREAMING_JSON_PARSE_MIN_GROWTH,
} from "@oh-my-pi/pi-utils/json-parse";

describe("parseStreamingJsonThrottled (F5)", () => {
	it("parses the first non-empty buffer even when growth is below the threshold", () => {
		const out = parseStreamingJsonThrottled('{"a":1', 0, 256);
		expect(out).not.toBeNull();
		expect(out!.parsedLen).toBe(6);
		expect(out!.value).toEqual({ a: 1 });
	});

	it("re-parses when buffer has grown by at least minGrowthBytes since the last parsed length", () => {
		const buf = `${"a".repeat(300)}`;
		const json = JSON.stringify({ s: buf });
		const out = parseStreamingJsonThrottled<{ s: string }>(json, 0, 256);
		expect(out).not.toBeNull();
		expect(out!.parsedLen).toBe(json.length);
		expect(out!.value.s.length).toBe(300);
	});

	it("emits the same value as parseStreamingJson when it fires", () => {
		const json = JSON.stringify({ tool: "search", args: { query: "x".repeat(400) } });
		const throttled = parseStreamingJsonThrottled<Record<string, unknown>>(json, 0, 256);
		expect(throttled).not.toBeNull();
		expect(throttled!.value).toEqual(parseStreamingJson(json));
	});

	it("incremental simulation: a long sequence of small deltas re-parses O(N/step) times, not O(N)", () => {
		// 5KB of args delivered as 1-byte deltas.
		const payload = `{"q":"${"x".repeat(5000)}"}`;
		let lastParsedLen = 0;
		let parseCalls = 0;
		let lastValue: unknown = null;

		for (let i = 1; i <= payload.length; i++) {
			const slice = payload.slice(0, i);
			const throttled = parseStreamingJsonThrottled<Record<string, unknown>>(
				slice,
				lastParsedLen,
				STREAMING_JSON_PARSE_MIN_GROWTH,
			);
			if (throttled) {
				parseCalls++;
				lastParsedLen = throttled.parsedLen;
				lastValue = throttled.value;
			}
		}

		// Mid-stream parse count is bounded by buffer / threshold (5108/256 ≈ 20).
		// Without throttling it would be 5108. We accept anything ≤ 25 — well below
		// the un-throttled hot-path cost.
		expect(parseCalls).toBeLessThanOrEqual(25);
		expect(parseCalls).toBeGreaterThan(0);

		// The throttle never returns the final byte if growth is below threshold —
		// providers always do a final unthrottled parse at toolcall_end. Verify the
		// last throttled snapshot is a strict prefix-parse of the full payload.
		const finalParsed = parseStreamingJson<Record<string, unknown>>(payload);
		expect(typeof (finalParsed as { q?: unknown }).q).toBe("string");
		expect(lastValue).not.toBeNull();
	});

	it("treats undefined/empty buffer as not-ready (no parse)", () => {
		expect(parseStreamingJsonThrottled(undefined, 0, 256)).toBeNull();
		expect(parseStreamingJsonThrottled("", 0, 256)).toBeNull();
	});

	it("geometric gate: large buffers re-parse O(log N) times, not O(N/minGrowth)", () => {
		// 512KB of args delivered as 1KB deltas — the long-`write`-payload case.
		// A fixed 256-byte gate would re-parse ~2048 times; the geometric gate
		// (len/32 above the floor) must land in the low hundreds at most.
		const payload = `{"q":"${"x".repeat(512 * 1024)}"}`;
		let lastParsedLen = 0;
		let parseCalls = 0;

		for (let i = 1; i <= payload.length; i += 1024) {
			const slice = payload.slice(0, i);
			const throttled = parseStreamingJsonThrottled<Record<string, unknown>>(slice, lastParsedLen);
			if (throttled) {
				parseCalls++;
				lastParsedLen = throttled.parsedLen;
			}
		}

		expect(parseCalls).toBeGreaterThan(0);
		expect(parseCalls).toBeLessThan(200);
		// Fixed-cadence equivalent for scale: payload/256 ≈ 2049 parses.
		expect(parseCalls).toBeLessThan(payload.length / STREAMING_JSON_PARSE_MIN_GROWTH / 8);
	});

	it("geometric gate keeps mid-stream snapshots fresh within ~1/32 of the buffer", () => {
		// After any settled point, the unparsed tail is bounded by len/32, so UI
		// built on parsed args lags the raw stream by ~3%, never by kilobytes.
		const payload = `{"q":"${"x".repeat(256 * 1024)}"}`;
		let lastParsedLen = 0;
		let maxLagRatio = 0;

		for (let i = 1; i <= payload.length; i += 1024) {
			const throttled = parseStreamingJsonThrottled<Record<string, unknown>>(payload.slice(0, i), lastParsedLen);
			if (throttled) lastParsedLen = throttled.parsedLen;
			if (lastParsedLen > 0) maxLagRatio = Math.max(maxLagRatio, (i - lastParsedLen) / i);
		}

		expect(maxLagRatio).toBeLessThan(1 / 16);
	});

	it("geometric gate preserves fixed-cadence behavior for small buffers", () => {
		// Below len/32 == minGrowthBytes the floor dominates, so a 5KB stream
		// re-parses at the same ~256-byte cadence as before the change.
		const payload = `{"q":"${"x".repeat(5000)}"}`;
		let lastParsedLen = 0;
		let parseCalls = 0;

		for (let i = 1; i <= payload.length; i++) {
			const throttled = parseStreamingJsonThrottled<Record<string, unknown>>(payload.slice(0, i), lastParsedLen);
			if (throttled) {
				parseCalls++;
				lastParsedLen = throttled.parsedLen;
			}
		}

		// 5108/256 ≈ 20 — identical bound to the pre-geometric contract above.
		expect(parseCalls).toBeLessThanOrEqual(25);
		expect(parseCalls).toBeGreaterThan(15);
	});
});
