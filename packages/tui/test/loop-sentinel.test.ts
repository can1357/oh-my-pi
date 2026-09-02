import { afterEach, describe, expect, test } from "bun:test";
import { popLoopPhase, pushLoopPhase, setLoopPhaseMirror, takeRecentLoopPhase } from "@oh-my-pi/pi-utils/loop-phase";
import {
	createSentinelJudge,
	createSentinelViews,
	PHASE_BYTES_MAX,
	readHeartbeat,
	readPhase,
	SENTINEL_SAB_BYTES,
	type SentinelAction,
	type SentinelJudge,
	type SentinelSample,
	type SentinelViews,
	writeHeartbeat,
	writePhase,
} from "../src/loop-sentinel-protocol";

function makeViews(): SentinelViews {
	return createSentinelViews(new SharedArrayBuffer(SENTINEL_SAB_BYTES));
}

describe("loop-sentinel SAB codec", () => {
	test("heartbeat round-trips through the shared buffer", () => {
		const views = makeViews();
		expect(readHeartbeat(views)).toBe(0);
		writeHeartbeat(views, 1234567890123);
		expect(readHeartbeat(views)).toBe(1234567890123);
		writeHeartbeat(views, 1234567890999);
		expect(readHeartbeat(views)).toBe(1234567890999);
	});

	test("phase label round-trips with its timestamp", () => {
		const views = makeViews();
		writePhase(views, "render:diff", 5000);
		expect(readPhase(views)).toEqual({ phase: "render:diff", phaseAtMs: 5000 });
	});

	test("undefined label publishes an empty phase", () => {
		const views = makeViews();
		writePhase(views, "render:diff", 5000);
		writePhase(views, undefined, 6000);
		expect(readPhase(views)).toEqual({ phase: undefined, phaseAtMs: 6000 });
	});

	test("oversized labels are truncated to the buffer capacity", () => {
		const views = makeViews();
		const label = "x".repeat(PHASE_BYTES_MAX * 2);
		writePhase(views, label, 7000);
		const read = readPhase(views);
		expect(read?.phase).toBe("x".repeat(PHASE_BYTES_MAX));
		expect(read?.phaseAtMs).toBe(7000);
	});

	test("non-ASCII labels survive the UTF-8 round-trip", () => {
		const views = makeViews();
		writePhase(views, "phase:⏳wedge", 8000);
		expect(readPhase(views)?.phase).toBe("phase:⏳wedge");
	});
});

describe("loop-sentinel judge", () => {
	// A wedge sample burning a full core: cpu delta tracks wall delta.
	function busy(judge: SentinelJudge, sample: SentinelSample): SentinelAction | undefined {
		return judge.observe(sample);
	}

	test("stays silent below the threshold", () => {
		const judge = createSentinelJudge({ thresholdMs: 10_000, killAfterMs: 0 });
		expect(judge.observe({ nowMs: 0, heartbeatMs: 0, cpuMs: 0 })).toBeUndefined();
		expect(judge.observe({ nowMs: 9_000, heartbeatMs: 0, cpuMs: 9_000 })).toBeUndefined();
	});

	test("reports a CPU-busy wedge on the rising edge, with phase attribution", () => {
		const judge = createSentinelJudge({ thresholdMs: 10_000, killAfterMs: 0 });
		expect(judge.observe({ nowMs: 0, heartbeatMs: 0, cpuMs: 0 })).toBeUndefined();
		const action = judge.observe({
			nowMs: 12_000,
			heartbeatMs: 0,
			cpuMs: 11_500,
			phase: "markdown:highlight",
			phaseAtMs: 500,
		});
		expect(action).toEqual({
			kind: "report",
			blockedMs: 12_000,
			cpuMs: 11_500,
			phase: "markdown:highlight",
			phaseAgeMs: 11_500,
		});
	});

	test("suppresses a low-CPU gap (system suspend), even a huge one", () => {
		const judge = createSentinelJudge({ thresholdMs: 10_000, killAfterMs: 0 });
		expect(judge.observe({ nowMs: 0, heartbeatMs: 0, cpuMs: 0 })).toBeUndefined();
		// 8 hours of wall time, 3ms of CPU: the laptop lid was closed.
		expect(judge.observe({ nowMs: 28_800_000, heartbeatMs: 0, cpuMs: 3 })).toBeUndefined();
	});

	test("re-reports only when the wedge duration doubles", () => {
		const judge = createSentinelJudge({ thresholdMs: 10_000, killAfterMs: 0 });
		expect(busy(judge, { nowMs: 0, heartbeatMs: 0, cpuMs: 0 })).toBeUndefined();
		expect(busy(judge, { nowMs: 10_000, heartbeatMs: 0, cpuMs: 10_000 })?.kind).toBe("report");
		expect(busy(judge, { nowMs: 11_000, heartbeatMs: 0, cpuMs: 11_000 })).toBeUndefined();
		expect(busy(judge, { nowMs: 19_000, heartbeatMs: 0, cpuMs: 19_000 })).toBeUndefined();
		const doubled = busy(judge, { nowMs: 20_000, heartbeatMs: 0, cpuMs: 20_000 });
		expect(doubled?.kind).toBe("report");
		expect(doubled && "blockedMs" in doubled ? doubled.blockedMs : 0).toBe(20_000);
		expect(busy(judge, { nowMs: 30_000, heartbeatMs: 0, cpuMs: 30_000 })).toBeUndefined();
		expect(busy(judge, { nowMs: 40_000, heartbeatMs: 0, cpuMs: 40_000 })?.kind).toBe("report");
	});

	test("emits one recovered action when the heartbeat advances after a report", () => {
		const judge = createSentinelJudge({ thresholdMs: 10_000, killAfterMs: 0 });
		expect(busy(judge, { nowMs: 0, heartbeatMs: 0, cpuMs: 0 })).toBeUndefined();
		expect(busy(judge, { nowMs: 15_000, heartbeatMs: 0, cpuMs: 15_000 })?.kind).toBe("report");
		const recovered = judge.observe({ nowMs: 16_000, heartbeatMs: 15_500, cpuMs: 16_000 });
		expect(recovered).toEqual({ kind: "recovered", blockedMs: 15_000 });
		// A quiet heartbeat advance (nothing was being reported) stays silent.
		expect(judge.observe({ nowMs: 17_000, heartbeatMs: 16_500, cpuMs: 16_100 })).toBeUndefined();
	});

	test("does not emit recovered for a suppressed (suspend) gap", () => {
		const judge = createSentinelJudge({ thresholdMs: 10_000, killAfterMs: 0 });
		expect(judge.observe({ nowMs: 0, heartbeatMs: 0, cpuMs: 0 })).toBeUndefined();
		expect(judge.observe({ nowMs: 60_000, heartbeatMs: 0, cpuMs: 1 })).toBeUndefined();
		expect(judge.observe({ nowMs: 61_000, heartbeatMs: 60_500, cpuMs: 2 })).toBeUndefined();
	});

	test("kill fires once at the ceiling and latches", () => {
		const judge = createSentinelJudge({ thresholdMs: 10_000, killAfterMs: 30_000 });
		expect(busy(judge, { nowMs: 0, heartbeatMs: 0, cpuMs: 0 })).toBeUndefined();
		expect(busy(judge, { nowMs: 10_000, heartbeatMs: 0, cpuMs: 10_000 })?.kind).toBe("report");
		const kill = busy(judge, { nowMs: 30_000, heartbeatMs: 0, cpuMs: 30_000 });
		expect(kill?.kind).toBe("kill");
		expect(busy(judge, { nowMs: 40_000, heartbeatMs: 0, cpuMs: 40_000 })).toBeUndefined();
	});

	test("kill is CPU-gated: a long suspend never kills a healthy process", () => {
		const judge = createSentinelJudge({ thresholdMs: 10_000, killAfterMs: 30_000 });
		expect(judge.observe({ nowMs: 0, heartbeatMs: 0, cpuMs: 0 })).toBeUndefined();
		expect(judge.observe({ nowMs: 90_000, heartbeatMs: 0, cpuMs: 5 })).toBeUndefined();
	});

	test("kill disabled (killAfterMs 0) keeps reporting forever instead", () => {
		const judge = createSentinelJudge({ thresholdMs: 10_000, killAfterMs: 0 });
		expect(busy(judge, { nowMs: 0, heartbeatMs: 0, cpuMs: 0 })).toBeUndefined();
		expect(busy(judge, { nowMs: 100_000, heartbeatMs: 0, cpuMs: 100_000 })?.kind).toBe("report");
		expect(busy(judge, { nowMs: 200_000, heartbeatMs: 0, cpuMs: 200_000 })?.kind).toBe("report");
	});
});

describe("loop-phase mirror", () => {
	afterEach(() => {
		setLoopPhaseMirror(undefined);
		// Drain the process-global phase stack and the retained recent slot so
		// later tests never inherit attribution state.
		while (takeRecentLoopPhase() !== undefined) {
			popLoopPhase();
		}
	});

	test("push and pop mirror the live top-of-stack label", () => {
		const seen: (string | undefined)[] = [];
		setLoopPhaseMirror(label => {
			seen.push(label);
		});
		pushLoopPhase("outer");
		pushLoopPhase("inner");
		popLoopPhase();
		expect(seen).toEqual(["outer", "inner", "outer"]);
	});

	test("popping the last phase mirrors the retained recent phase", () => {
		const seen: (string | undefined)[] = [];
		setLoopPhaseMirror(label => {
			seen.push(label);
		});
		pushLoopPhase("only");
		popLoopPhase();
		// Matches takeRecentLoopPhase semantics: the culprit stays attributable
		// after its synchronous push/pop completes.
		expect(seen).toEqual(["only", "only"]);
	});

	test("a throwing mirror never breaks the instrumented hot path", () => {
		setLoopPhaseMirror(() => {
			throw new Error("mirror exploded");
		});
		expect(() => {
			pushLoopPhase("hot");
			popLoopPhase();
		}).not.toThrow();
	});

	test("clearing the mirror stops the callbacks", () => {
		const seen: (string | undefined)[] = [];
		setLoopPhaseMirror(label => {
			seen.push(label);
		});
		pushLoopPhase("a");
		setLoopPhaseMirror(undefined);
		pushLoopPhase("b");
		popLoopPhase();
		popLoopPhase();
		expect(seen).toEqual(["a"]);
	});
});
