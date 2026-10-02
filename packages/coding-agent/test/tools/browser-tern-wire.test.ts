import { afterEach, describe, expect, it } from "bun:test";
import {
	isTernUnavailable,
	TernBrowserError,
	TernFrameReader,
	TernSocketClient,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tern/wire";
import { type FakeDaemon, frame, startFakeDaemon } from "./tern-fake-daemon";

let daemon: FakeDaemon | undefined;
let client: TernSocketClient | undefined;

afterEach(async () => {
	client?.close();
	client = undefined;
	await daemon?.close();
	daemon = undefined;
});

describe("TernSocketClient", () => {
	it("greets as a protocol-9 script client and correlates answers by id", async () => {
		const held: bigint[] = [];
		daemon = await startFakeDaemon((op, id) => {
			if (op.op === "slow") {
				held.push(id);
				return null;
			}
			return { ok: { echo: op.value } };
		});
		client = new TernSocketClient({ socketPath: daemon.socketPath });
		const slow = client.request({ op: "slow" });
		const fast = await client.request({ op: "fast", value: 7 });
		expect(fast).toEqual({ echo: 7 });
		daemon.answer(held[0]!, { ok: "late" });
		expect(await slow).toBe("late");
		// [len=7][tag 0][u32 LE 9][identity absent][ClientKind::Cli]
		expect([...daemon.hellos[0]!]).toEqual([0x00, 9, 0, 0, 0, 0x00, 0x01]);
		expect(frame(daemon.hellos[0]!).slice(0, 4)).toEqual(new Uint8Array([7, 0, 0, 0]));
	});

	it("turns an error envelope into a TernBrowserError carrying its kind", async () => {
		daemon = await startFakeDaemon(() => ({ error: { kind: "no_window", message: "no Tern window is open" } }));
		client = new TernSocketClient({ socketPath: daemon.socketPath });
		const failure = await client.request({ op: "open" }).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(TernBrowserError);
		expect((failure as TernBrowserError).kind).toBe("no_window");
		expect((failure as TernBrowserError).message).toContain("no Tern window is open");
		expect(isTernUnavailable(failure)).toBe(true);
	});

	it("reports a version refusal naming both protocol versions", async () => {
		daemon = await startFakeDaemon(() => ({ ok: {} }), {
			refusal: "the session daemon speaks protocol 7, this window 6",
		});
		client = new TernSocketClient({ socketPath: daemon.socketPath });
		const failure = await client.connect().catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(TernBrowserError);
		expect((failure as TernBrowserError).kind).toBe("refused");
		expect((failure as TernBrowserError).message).toContain("protocol 7");
		expect((failure as TernBrowserError).message).toContain("omp speaks Tern protocol 9");
		expect(isTernUnavailable(failure)).toBe(true);
	});

	it("fails to connect to a missing socket with an unavailable error", async () => {
		client = new TernSocketClient({ socketPath: "/tmp/omp-tern-missing-daemon.sock" });
		const failure = await client.connect().catch((error: unknown) => error);
		expect(isTernUnavailable(failure)).toBe(true);
		expect((failure as TernBrowserError).kind).toBe("connect");
	});

	it("rejects an op whose fields are not JSON without leaving it pending", async () => {
		daemon = await startFakeDaemon(() => ({ ok: "fine" }));
		client = new TernSocketClient({ socketPath: daemon.socketPath });
		const cyclic: Record<string, unknown> = { op: "eval" };
		cyclic.self = cyclic;
		const failure = await client.request(cyclic, { timeoutMs: 20 }).catch((error: unknown) => error);
		expect((failure as TernBrowserError).kind).toBe("invalid");
		expect(daemon.requests).toHaveLength(0);
		// The connection stays usable.
		expect(await client.request({ op: "state" })).toBe("fine");
	});

	it("hands a late answer of an abandoned op to its onLateAnswer hook", async () => {
		const received = Promise.withResolvers<bigint>();
		daemon = await startFakeDaemon((_op, id) => {
			received.resolve(id);
			return null;
		});
		client = new TernSocketClient({ socketPath: daemon.socketPath });
		const late = Promise.withResolvers<unknown>();
		const aborter = new AbortController();
		const pending = client.request({ op: "open" }, { signal: aborter.signal, onLateAnswer: late.resolve });
		const id = await received.promise;
		aborter.abort(new Error("gave up"));
		expect(((await pending.catch((error: unknown) => error)) as Error).message).toBe("gave up");
		daemon.answer(id, { ok: { block: 12 } });
		expect(await late.promise).toEqual({ block: 12 });
	});

	it("assembles frames split across many chunks, and several frames in one chunk", () => {
		const reader = new TernFrameReader();
		const big = new Uint8Array(100_000).map((_, index) => index % 251);
		const bytes = frame(big);
		const payloads: Uint8Array[] = [];
		for (let offset = 0; offset < bytes.length; offset += 777)
			payloads.push(...reader.push(bytes.subarray(offset, offset + 777)));
		expect(payloads).toHaveLength(1);
		expect(payloads[0]).toEqual(big);
		const both = new Uint8Array([...frame(new Uint8Array([1, 2])), ...frame(new Uint8Array([3]))]);
		expect(reader.push(both).map(payload => [...payload])).toEqual([[1, 2], [3]]);
	});

	it("rejects pending ops on close, on timeout and on abort", async () => {
		daemon = await startFakeDaemon(() => null);
		client = new TernSocketClient({ socketPath: daemon.socketPath });
		const timedOut = await client.request({ op: "state" }, { timeoutMs: 30 }).catch((error: unknown) => error);
		expect((timedOut as TernBrowserError).kind).toBe("timeout");
		const aborter = new AbortController();
		const aborted = client.request({ op: "state" }, { signal: aborter.signal }).catch((error: unknown) => error);
		aborter.abort(new Error("stop"));
		expect(((await aborted) as Error).message).toBe("stop");
		const pending = client.request({ op: "state" }).catch((error: unknown) => error);
		client.close();
		const closed = await pending;
		expect((closed as TernBrowserError).kind).toBe("closed");
		expect(isTernUnavailable(closed)).toBe(false);
	});
});
