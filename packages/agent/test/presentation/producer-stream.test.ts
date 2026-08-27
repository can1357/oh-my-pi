import { describe, expect, it } from "bun:test";
import type { ToolPresentationEvent, ToolPresentationProducer } from "../../src/presentation";
import {
	byteLengthOf,
	createLiveTerminalBinding,
	factAudience,
	nonZeroExitCode,
	outcomeExitCode,
	presentationSeverity,
	streamId,
	ToolPresentationStream,
} from "../../src/presentation";

function collect(): { events: ToolPresentationEvent[]; stream: ToolPresentationStream } {
	const events: ToolPresentationEvent[] = [];
	const stream = new ToolPresentationStream(streamId("call-1"), event => events.push(event));
	return { events, stream };
}

/** Widen a branded numeric id back to `number` for value assertions. */
function plain(value: number): number {
	return value;
}

function appends(
	events: readonly ToolPresentationEvent[],
): Extract<ToolPresentationEvent, { type: "terminal_append" }>[] {
	return events.filter(
		(event): event is Extract<ToolPresentationEvent, { type: "terminal_append" }> => event.type === "terminal_append",
	);
}

describe("ToolPresentationStream byte accounting", () => {
	it("emits monotonic sequences and contiguous UTF-8 offsets for repeated identical chunks", () => {
		const { events, stream } = collect();
		// The adversarial case for overlap inference: three byte-identical chunks.
		// Only offsets can tell them apart, which is the point.
		stream.appendTerminal("SAME-LINE-0001\n");
		stream.appendTerminal("SAME-LINE-0001\n");
		stream.appendTerminal("SAME-LINE-0001\n");

		const emitted = appends(events);
		expect(emitted.map(event => plain(event.sequence))).toEqual([0, 1, 2]);
		expect(emitted.map(event => plain(event.startByte))).toEqual([0, 15, 30]);
		expect(plain(stream.nextByte)).toBe(45);
	});

	it("counts UTF-8 bytes, not UTF-16 code units", () => {
		const { events, stream } = collect();
		stream.appendTerminal("héllo→\n"); // 1+2+3*1+3+1 = 10 bytes, 7 code units
		stream.appendTerminal("ok\n");

		const emitted = appends(events);
		expect(byteLengthOf("héllo→\n")).toBe(10);
		expect(plain(emitted[0]?.startByte ?? -1)).toBe(0);
		expect(plain(emitted[1]?.startByte ?? -1)).toBe(10);
		expect(plain(stream.nextByte)).toBe(13);
	});

	it("keeps startByte + byteLength(data) equal to the next chunk's startByte", () => {
		const { events, stream } = collect();
		for (const chunk of ["a", "→", "😀", "\n", "tail"]) stream.appendTerminal(chunk);

		const emitted = appends(events);
		let expected = 0;
		for (const event of emitted) {
			expect(plain(event.startByte)).toBe(expected);
			expected += byteLengthOf(event.data);
		}
		expect(plain(stream.nextByte)).toBe(expected);
	});

	it("refuses a chunk that ends inside a surrogate pair", () => {
		const { stream } = collect();
		const emoji = "😀";
		expect(() => stream.appendTerminal(emoji.slice(0, 1))).toThrow(/surrogate/);
	});

	it("treats an empty append as a no-op rather than a zero-length event", () => {
		const { events, stream } = collect();
		stream.appendTerminal("");
		expect(events).toEqual([]);
		expect(plain(stream.nextByte)).toBe(0);
	});
});

describe("ToolPresentationStream freeze barrier", () => {
	it("flushes registered producers before freezing and is idempotent", async () => {
		const { events, stream } = collect();
		let flushes = 0;
		stream.registerFlusher(scope => {
			flushes++;
			scope.appendTerminal("PENDING-CHUNK\n");
		});

		await Promise.all([stream.freeze(), stream.freeze()]);
		await stream.freeze();

		expect(flushes).toBe(1);
		expect(appends(events).map(event => event.data)).toEqual(["PENDING-CHUNK\n"]);
		expect(stream.frozen).toBe(true);
	});

	it("rejects appends after the barrier closed", async () => {
		const { stream } = collect();
		await stream.freeze();
		expect(() => stream.appendTerminal("late\n")).toThrow(/after freeze/);
	});

	it("lets an unregistered flusher opt out", async () => {
		const { events, stream } = collect();
		const unregister = stream.registerFlusher(scope => scope.appendTerminal("nope\n"));
		unregister();
		await stream.freeze();
		expect(appends(events)).toEqual([]);
	});

	it("rejects an unrelated holder's appendTerminal while a suspended async flusher is mid-freeze", async () => {
		// The literal reproduction: append authority must not stay open for the whole
		// `await flush()` window just because *some* flusher is running. A `#flushDepth`
		// counter is ambient — anything holding the producer handle could exploit the
		// window while the flusher is suspended on an unrelated await. Authority must be
		// scoped to the specific flusher invocation instead.
		const { stream } = collect();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();

		stream.registerFlusher(async scope => {
			entered.resolve();
			await release.promise;
			scope.appendTerminal("from-flusher\n");
		});

		const freezing = stream.freeze();
		await entered.promise;

		// Must be rejected: this is not the scope the suspended flusher was handed.
		expect(() => stream.appendTerminal("external\n")).toThrow(/after freeze/);

		release.resolve();
		await freezing;
	});

	it("keeps each flusher's scope revoked after it returns, even while a later flusher is still running", async () => {
		// Flushers run sequentially (in registration order), each still owning a
		// distinct pending buffer. The property under test is scope lifetime, not
		// concurrency: the first flusher's scope must already be dead by the time the
		// second one runs.
		const { events, stream } = collect();
		let capturedFirstScope: { appendTerminal(data: string): void } | undefined;

		stream.registerFlusher(scope => {
			capturedFirstScope = scope;
			scope.appendTerminal("first\n");
		});
		stream.registerFlusher(scope => {
			// The first flusher already returned; its scope must be dead here.
			expect(() => capturedFirstScope?.appendTerminal("late\n")).toThrow(/after its flusher returned/);
			scope.appendTerminal("second\n");
		});

		await stream.freeze();
		expect(appends(events).map(event => event.data)).toEqual(["first\n", "second\n"]);
	});

	it("revokes a throwing flusher's scope in finally, before the barrier finishes", async () => {
		const { events, stream } = collect();
		let capturedScope: { appendTerminal(data: string): void } | undefined;
		stream.registerFlusher(scope => {
			capturedScope = scope;
			scope.appendTerminal("before-throw\n");
			throw new Error("flusher exploded");
		});

		await expect(stream.freeze()).rejects.toThrow("flusher exploded");
		expect(appends(events).map(event => event.data)).toEqual(["before-throw\n"]);
		expect(stream.frozen).toBe(true);
		expect(() => capturedScope?.appendTerminal("late\n")).toThrow(/after its flusher returned/);
		// The ordinary handle is refused too, not just the dead scope.
		expect(() => stream.appendTerminal("external\n")).toThrow(/after freeze/);
	});

	it("rejects a captured scope reused after its flusher call already returned", async () => {
		const { stream } = collect();
		let capturedScope: { appendTerminal(data: string): void } | undefined;
		stream.registerFlusher(scope => {
			capturedScope = scope;
		});
		await stream.freeze();
		expect(() => capturedScope?.appendTerminal("late\n")).toThrow(/after its flusher returned/);
	});
});

/** `true` only when `A` and `B` are the same type; see `IsExact` in coding-agent. */
type IsExact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** The complete surface a tool may reach. Adding a member here is a deliberate act. */
type ExpectedProducerSurface =
	| "streamId"
	| "phase"
	| "frozen"
	| "nextByte"
	| "appendTerminal"
	| "fact"
	| "attachment"
	| "declareDisplay"
	| "attachLiveTerminal"
	| "registerFlusher"
	| "freeze";

/**
 * Compile-time proof that the handle a tool receives is exactly the surface above.
 *
 * Fails `tsgo` if a member is added, removed or renamed — in particular if
 * `declareGap` ever appears on it, which would hand every built-in the ability to
 * fabricate a discontinuity.
 */
const PRODUCER_SURFACE_IS_CLOSED: IsExact<keyof ToolPresentationProducer, ExpectedProducerSurface> = true;

/** `declareGap` is not a key of the producer handle. */
const GAP_IS_OFF_THE_PRODUCER_HANDLE: "declareGap" extends keyof ToolPresentationProducer ? false : true = true;

/** The concrete stream, however, must still expose it to the bounded-queue adapter. */
export const GAP_IS_ON_THE_CONCRETE_STREAM: "declareGap" extends keyof ToolPresentationStream ? true : false = true;
describe("ToolPresentationStream gap ownership", () => {
	it("advances the cursor across the declared range so later offsets stay absolute", () => {
		const { events, stream } = collect();
		stream.appendTerminal("head\n");
		stream.declareGap(4096);
		stream.appendTerminal("tail\n");

		expect(events.map(event => event.type)).toEqual(["terminal_append", "terminal_gap", "terminal_append"]);
		const gap = events[1];
		if (gap?.type !== "terminal_gap") throw new Error("expected a gap event");
		expect(plain(gap.fromByte)).toBe(5);
		expect(plain(gap.toByte)).toBe(4101);
		expect(plain(appends(events)[1]?.startByte ?? -1)).toBe(4101);
	});

	it("is not reachable through the producer interface a tool receives", () => {
		const { stream } = collect();
		// A real compile-time contract, not a hand-written key list. The previous
		// version asserted `new Set([...literal keys...]).has("declareGap") === false`,
		// which is a tautology: it could not fail no matter what the interface said.
		//
		// `PRODUCER_SURFACE_IS_CLOSED` and `GAP_IS_OFF_THE_PRODUCER_HANDLE` below are
		// checked by `tsgo -p tsconfig.presentation.json`; adding `declareGap` (or any
		// other mutator) to `ToolPresentationProducer` makes them fail to compile.
		expect(GAP_IS_OFF_THE_PRODUCER_HANDLE).toBe(true);
		expect(PRODUCER_SURFACE_IS_CLOSED).toBe(true);
		// The runtime half: the concrete stream still has it, for the bounded-queue
		// adapter that is its only legitimate caller.
		expect(typeof stream.declareGap).toBe("function");
	});
});

describe("presentation facts", () => {
	it("mints stable unique ids and echoes each fact exactly once", () => {
		const { events, stream } = collect();
		const wall = stream.fact({ kind: "wall_time", ms: 1234 });
		const artifact = stream.fact({ kind: "artifact", artifactId: "7" });

		expect(wall).not.toBe(artifact);
		const factEvents = events.filter(event => event.type === "fact");
		expect(factEvents).toHaveLength(2);
		expect(stream.declaredFacts.map(fact => fact.id)).toEqual([wall, artifact]);
	});

	it("derives audience from kind rather than from the producer", () => {
		expect(factAudience("wall_time")).toBe("all");
		expect(factAudience("model_guidance")).toBe("all");
	});

	it("keeps truncation human-only globally — read's model-facing exception lives in its own scoped projection, not FACT_AUDIENCE", () => {
		// bash/eval's middle-elision case: the model already sees `OutputSink`'s
		// own marker in the retained bytes, so `FACT_AUDIENCE` must stay
		// `"human"` for every producer including read's own middle-direction
		// calls (none exist today, but the table has no per-producer override —
		// see facts.ts's "Audience is not authorable by a producer"). Read's
		// non-middle case instead gets a typed *projection*
		// (`renderReadTruncationTrail` in coding-agent's `presentation/projections.ts`)
		// rather than changing this table — this test is the regression guard
		// that a future edit doesn't take the easier, forbidden path.
		expect(factAudience("truncation")).toBe("human");
		expect(factAudience("limit")).toBe("human");
		expect(factAudience("artifact")).toBe("human");
	});
});

describe("tool outcome", () => {
	it("classifies a timeout as a failure that renders as a warning", () => {
		const outcome = {
			kind: "failed",
			failure: { reason: "process", message: "Command timed out after 1 seconds" },
			process: { kind: "timed_out", timeoutMs: 1000 },
		} as const;
		expect(presentationSeverity(outcome)).toBe("warning");
		expect(outcomeExitCode(outcome)).toBeUndefined();
	});

	it("reports 0 for a success and the real code for a nonzero exit", () => {
		expect(outcomeExitCode({ kind: "succeeded" })).toBe(0);
		expect(
			outcomeExitCode({
				kind: "failed",
				failure: { reason: "process", message: "exit 3" },
				process: { kind: "exited", code: nonZeroExitCode(3) },
			}),
		).toBe(3);
	});

	it("refuses to mint a zero nonzero-exit code", () => {
		expect(() => nonZeroExitCode(0)).toThrow(/rejects 0/);
	});
});

describe("live terminal binding", () => {
	it("requires a terminal id and carries no serializable extras", () => {
		expect(() => createLiveTerminalBinding("")).toThrow();
		const binding = createLiveTerminalBinding("term-9");
		expect(binding.terminalId).toBe("term-9");
		expect(Object.keys(binding)).toEqual(["terminalId"]);
	});
});
