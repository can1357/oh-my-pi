import { afterEach, describe, expect, it } from "bun:test";
import {
	decodeTernReply,
	isTernUnavailable,
	TernError,
	TernFrameReader,
	TernSocketClient,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tern/wire";
import { type FakeDaemon, frame, jsonPayload, startFakeDaemon } from "./tern-fake-daemon";

let daemon: FakeDaemon | undefined;
let client: TernSocketClient | undefined;

afterEach(async () => {
	client?.close();
	client = undefined;
	await daemon?.close();
	daemon = undefined;
});

describe("TernSocketClient", () => {
	it("greets with a JSON hello and correlates answers by id", async () => {
		const held: number[] = [];
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
		expect(daemon.requests.map(request => request.id)).toEqual([1, 2]);
		// The bytes a real daemon reads: a JSON object first, which is how Tern tells it from its protobuf clients.
		expect(new TextDecoder().decode(daemon.hellos[0])).toBe('{"hello":{}}');
		expect(frame(daemon.hellos[0]!).slice(0, 4)).toEqual(new Uint8Array([12, 0, 0, 0]));
	});

	it("skips members and message kinds it does not know and rejects frames that are not answers", () => {
		expect(decodeTernReply(jsonPayload({ welcome: { version: 99 } }))).toEqual({ type: "welcome", ops: [] });
		expect(decodeTernReply(jsonPayload({ welcome: { ops: ["browser", 7, "fork"] } }))).toEqual({
			type: "welcome",
			ops: ["browser", "fork"],
		});
		expect(decodeTernReply(jsonPayload({ id: 3, output: {} }))).toEqual({ type: "other" });
		expect(decodeTernReply(jsonPayload({ id: 3, browser: { ok: 1 }, extra: true }))).toEqual({
			type: "browser",
			id: 3,
			answer: { ok: 1 },
		});
		for (const payload of [
			new Uint8Array([0x0a, 0x04]),
			jsonPayload([1, 2]),
			jsonPayload({ browser: { ok: 1 } }),
			new Uint8Array([0x7b, 0xff, 0x7d]),
		]) {
			const failure = (() => {
				try {
					decodeTernReply(payload);
					return undefined;
				} catch (error) {
					return error;
				}
			})();
			expect(failure).toBeInstanceOf(TernError);
			expect((failure as TernError).kind).toBe("protocol");
		}
	});

	it("turns an error envelope into a TernError carrying its kind", async () => {
		daemon = await startFakeDaemon(() => ({ error: { kind: "no_window", message: "no Tern window is open" } }));
		client = new TernSocketClient({ socketPath: daemon.socketPath });
		const failure = await client.request({ op: "open" }).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(TernError);
		expect((failure as TernError).kind).toBe("no_window");
		expect((failure as TernError).message).toContain("no Tern window is open");
		expect(isTernUnavailable(failure)).toBe(true);
	});

	it("treats a Tern from before the JSON protocol, which hangs up on the hello, as unavailable", async () => {
		daemon = await startFakeDaemon(() => ({ ok: {} }), { hangUp: true });
		client = new TernSocketClient({ socketPath: daemon.socketPath });
		const failure = await client.connect().catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(TernError);
		expect((failure as TernError).kind).toBe("connect");
		expect((failure as TernError).message).toContain("without omp's JSON protocol");
		expect(isTernUnavailable(failure)).toBe(true);
	});

	it("fails to connect to a missing socket with an unavailable error", async () => {
		client = new TernSocketClient({ socketPath: "/tmp/omp-tern-missing-daemon.sock" });
		const failure = await client.connect().catch((error: unknown) => error);
		expect(isTernUnavailable(failure)).toBe(true);
		expect((failure as TernError).kind).toBe("connect");
	});

	it("rejects an op whose fields are not JSON without leaving it pending", async () => {
		daemon = await startFakeDaemon(() => ({ ok: "fine" }));
		client = new TernSocketClient({ socketPath: daemon.socketPath });
		const cyclic: Record<string, unknown> = { op: "eval" };
		cyclic.self = cyclic;
		const failure = await client.request(cyclic, { timeoutMs: 20 }).catch((error: unknown) => error);
		expect((failure as TernError).kind).toBe("invalid");
		expect(daemon.requests).toHaveLength(0);
		// The connection stays usable.
		expect(await client.request({ op: "state" })).toBe("fine");
	});

	it("hands a late answer of an abandoned op to its onLateAnswer hook", async () => {
		const received = Promise.withResolvers<number>();
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

	it("reports fork unsupported by a Tern whose welcome lists no ops", async () => {
		daemon = await startFakeDaemon(() => ({ ok: {} }));
		client = new TernSocketClient({ socketPath: daemon.socketPath });
		await client.connect();
		expect(client.supports("fork")).toBe(false);
	});

	it("sends a fork to a Tern that lists it and resolves the new pane's block", async () => {
		daemon = await startFakeDaemon(() => ({ ok: {} }), {
			welcome: { ops: ["browser", "fork"] },
			fork: () => ({ ok: { block: 9 } }),
		});
		client = new TernSocketClient({ socketPath: daemon.socketPath });
		await client.connect();
		expect(client.supports("fork")).toBe(true);
		expect(await client.fork({ block: 5 })).toBe(9);
		expect(daemon.forks).toEqual([{ id: 1, op: { block: 5 } }]);
	});

	it("turns a fork error answer into a TernError carrying its kind", async () => {
		daemon = await startFakeDaemon(() => ({ ok: {} }), {
			welcome: { ops: ["browser", "fork"] },
			fork: () => ({ error: { kind: "not_agent", message: "block 5 reported no session file" } }),
		});
		client = new TernSocketClient({ socketPath: daemon.socketPath });
		const failure = await client.fork({ block: 5 }).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(TernError);
		expect((failure as TernError).kind).toBe("not_agent");
	});

	it("rejects pending ops on close, on timeout and on abort", async () => {
		daemon = await startFakeDaemon(() => null);
		client = new TernSocketClient({ socketPath: daemon.socketPath });
		const timedOut = await client.request({ op: "state" }, { timeoutMs: 30 }).catch((error: unknown) => error);
		expect((timedOut as TernError).kind).toBe("timeout");
		const aborter = new AbortController();
		const aborted = client.request({ op: "state" }, { signal: aborter.signal }).catch((error: unknown) => error);
		aborter.abort(new Error("stop"));
		expect(((await aborted) as Error).message).toBe("stop");
		const pending = client.request({ op: "state" }).catch((error: unknown) => error);
		client.close();
		const closed = await pending;
		expect((closed as TernError).kind).toBe("closed");
		expect(isTernUnavailable(closed)).toBe(false);
	});
});
