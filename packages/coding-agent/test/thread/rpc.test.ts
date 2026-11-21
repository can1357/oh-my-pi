import { afterEach, describe, expect, it } from "bun:test";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import type { CounterProtocol, FixtureMainApi, FixtureWorkerApi } from "../fixtures/rpc-link-worker";
import {
	RpcClosedError,
	type RpcApi,
	RpcEncodeError,
	type RpcEndpoint,
	type RpcFrame,
	RpcLink,
	type RpcMethod,
	registerRpcError,
	rpcLossy,
	rpcSync,
} from "../../src/thread/rpc";

class FixtureFailure extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FixtureFailure";
	}
}
registerRpcError("FixtureFailure", message => new FixtureFailure(message));

class Token {
	constructor(readonly id: string) {}
}

class Counter {
	count = 0;
}

let worker: Worker | undefined;
let channel: MessageChannel | undefined;

afterEach(() => {
	worker?.terminate();
	worker = undefined;
	channel?.port1.close();
	channel = undefined;
});

type LossyOwnerApi = { target: RpcMethod<[], (...args: unknown[]) => unknown> };

function portEndpoint(port: MessagePort): RpcEndpoint {
	return {
		send: frame => port.postMessage(frame),
		listen: handler => {
			const listener = (frame: RpcFrame): void => handler(frame);
			port.on("message", listener);
			return () => port.off("message", listener);
		},
	};
}

/** Two links on this thread; returns the importer's proxy for `fn`, exported by the other link. */
async function importLossy(fn: (...args: unknown[]) => void): Promise<(...args: unknown[]) => unknown> {
	const pair = new MessageChannel();
	channel = pair;
	const owner = new RpcLink<LossyOwnerApi, RpcApi>(portEndpoint(pair.port1), { name: "owner" });
	const importer = new RpcLink<RpcApi, LossyOwnerApi>(portEndpoint(pair.port2), { name: "importer" });
	owner.handle("target", () => rpcLossy(fn));
	return importer.call("target");
}

async function startFixture(): Promise<{
	link: RpcLink<FixtureMainApi, FixtureWorkerApi>;
	log: string[];
	tokens: Map<string, Token>;
}> {
	const spawned = new Worker(new URL("../fixtures/rpc-link-worker.ts", import.meta.url).href, { type: "module" });
	worker = spawned;
	const channel = new MessageChannel();
	const counter = new SharedArrayBuffer(4);
	const { promise: ready, resolve } = Promise.withResolvers<void>();
	const onReady = (event: MessageEvent): void => {
		if (event.data?.ready) {
			spawned.removeEventListener("message", onReady);
			resolve();
		}
	};
	spawned.addEventListener("message", onReady);
	spawned.postMessage({ sync: channel.port2, counter }, [channel.port2]);
	await ready;
	const link = new RpcLink<FixtureMainApi, FixtureWorkerApi>(
		{
			send: frame => spawned.postMessage(frame),
			listen: handler => {
				const listener = (event: MessageEvent<RpcFrame>): void => handler(event.data);
				spawned.addEventListener("message", listener);
				return () => spawned.removeEventListener("message", listener);
			},
		},
		{ name: "test", syncReplies: { port: channel.port1, counter: new Int32Array(counter) } },
	);
	const log: string[] = [];
	const tokens = new Map<string, Token>();
	link.codec<Token>({
		kind: "token",
		is: (value): value is Token => value instanceof Token,
		encode: token => token.id,
		decode: data => {
			const id = String(data);
			let token = tokens.get(id);
			if (!token) {
				token = new Token(id);
				tokens.set(id, token);
			}
			return token;
		},
	});
	link.handle("add", (a, b) => a + b);
	link.onNotify("log", line => {
		log.push(line);
	});
	link.handle("entries", () => [...log]);
	link.handle("fail", () => {
		const error = new FixtureFailure("main refused");
		// Retry/rotation policy classifies errors by a hidden id; it must survive the hop.
		Object.defineProperty(error, "errorId", { value: 7, enumerable: false });
		throw error;
	});
	link.handle("echoToken", token => token);
	link.handle("echo", value => value);
	link.exportClass<Counter, CounterProtocol>("counter", (value): value is Counter => value instanceof Counter, {
		increment: (counter, by) => {
			counter.count += by;
		},
		value: counter => counter.count,
	});
	link.handle("callBack", async callback => Number(await callback(4)));
	return { link, log, tokens };
}

describe("RpcLink", () => {
	it("serves a worker's sync call after every notification it sent earlier", async () => {
		const { link } = await startFixture();
		expect(await link.call("syncAfterNotify")).toEqual(["first", "second"]);
		expect(await link.call("syncAdd", 2, 40)).toBe(42);
	});

	it("rebuilds registered error classes thrown by the remote handler", async () => {
		const { link } = await startFixture();
		expect(await link.call("callMainFailure")).toEqual({
			name: "FixtureFailure",
			message: "main refused",
			errorId: 7,
			idEnumerable: false,
		});
	});

	it("mirrors an abort and its reason onto the remote signal", async () => {
		const { link } = await startFixture();
		const controller = new AbortController();
		const observed = link.call("waitForAbort", controller.signal);
		controller.abort(new DOMException("stop now", "AbortError"));
		expect(await observed).toEqual({ name: "AbortError", message: "stop now" });
	});

	it("lets a worker call a main function synchronously only when it is marked sync", async () => {
		const { link } = await startFixture();
		expect(
			await link.call(
				"callbackKind",
				rpcSync((value: number) => value + 1),
			),
		).toBe("sync");
		expect(await link.call("callbackKind", (value: number) => value + 1)).toBe("async");
	});

	it("invokes worker callbacks from the main thread", async () => {
		const { link } = await startFixture();
		expect(await link.call("passCallback")).toBe(40);
	});

	it("decodes a codec value back to the sender's canonical object", async () => {
		const { link } = await startFixture();
		expect(await link.call("tokenRoundTrip")).toBe(true);
	});

	it("serves exported objects through one canonical proxy that travels back as the original", async () => {
		const { link } = await startFixture();
		const counter = new Counter();
		// The worker echoes its proxy to main; main must see the proxy decode back to its own counter.
		const seen: unknown[] = [];
		link.handle("echo", value => {
			seen.push(value);
			return value;
		});
		expect(await link.call("bumpCounter", counter)).toEqual({ value: 5, sameOnMain: true });
		expect(seen).toEqual([counter]);
		expect(counter.count).toBe(5);
	});

	it("returns a main function sent to the worker as the same function object", async () => {
		const { link } = await startFixture();
		const fn = (): number => 1;
		expect(await link.call("returnArg", fn)).toBe(fn);
	});

	it("refuses class instances without a codec at the sender", async () => {
		const { link } = await startFixture();
		class Live {
			readonly handle = 1;
		}
		await expect(link.call("accept", new Live())).rejects.toBeInstanceOf(RpcEncodeError);
	});

	it("delivers one object passed in several lossy argument positions as one object", async () => {
		const received: unknown[][] = [];
		const target = await importLossy((...args) => {
			received.push(args);
		});
		class Box {
			constructor(readonly inner: object) {}
		}
		const shared = { n: 1 };
		const box = new Box(shared);
		await target(shared, shared, box, box);
		const [first, second, boxA, boxB] = received[0] ?? [];
		expect(first).toEqual({ n: 1 });
		expect(second).toBe(first);
		expect(boxB).toBe(boxA);
		expect(Reflect.get(boxA ?? {}, "inner")).toBe(first);
	});

	it("copies an own __proto__ field as data in lossy arguments", async () => {
		const received: unknown[][] = [];
		const target = await importLossy((...args) => {
			received.push(args);
		});
		class Holder {
			constructor() {
				Object.defineProperty(this, "__proto__", {
					value: { fromClass: true },
					enumerable: true,
					writable: true,
					configurable: true,
				});
			}
		}
		const parsed: unknown = JSON.parse('{"__proto__":{"fromJson":true},"ok":1}');
		await target(parsed, new Holder());
		const [record, holder] = received[0] ?? [];
		const expectOwnProtoField = (value: unknown, field: object): void => {
			if (typeof value !== "object" || value === null) throw new Error("argument did not arrive as an object");
			expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
			expect(Object.getOwnPropertyDescriptor(value, "__proto__")?.value).toEqual(field);
		};
		expectOwnProtoField(record, { fromJson: true });
		expectOwnProtoField(holder, { fromClass: true });
		expect(Reflect.get(record ?? {}, "ok")).toBe(1);
	});

	it("round-trips user records carrying the __rpc marker key", async () => {
		const markers = ["fn", "sig", "p", "obj", "back", "err", "codec", "graph", "esc", "arbitrary"];
		const sample = (): unknown => ({
			top: markers.map(marker => ({ __rpc: marker, id: 1, kind: "k", v: [1], data: { __rpc: marker } })),
			nested: { deep: [{ __rpc: "fn", sync: true, lossy: false, id: 0 }] },
		});
		const pair = new MessageChannel();
		channel = pair;
		type EchoApi = { echo: RpcMethod<[unknown], unknown> };
		const owner = new RpcLink<EchoApi, RpcApi>(portEndpoint(pair.port1), { name: "owner" });
		const caller = new RpcLink<RpcApi, EchoApi>(portEndpoint(pair.port2), { name: "caller" });
		const seen: unknown[] = [];
		owner.handle("echo", value => {
			seen.push(value);
			return value;
		});
		for (const marker of markers) {
			const record = { __rpc: marker, payload: 1 };
			expect(await caller.call("echo", record)).toEqual({ __rpc: marker, payload: 1 });
		}
		expect(await caller.call("echo", sample())).toEqual(sample());
		expect(seen.at(-1)).toEqual(sample());

		const received: unknown[][] = [];
		const target = await importLossy((...args) => {
			received.push(args);
		});
		await target(sample(), { __rpc: "obj", id: 7 });
		expect(received[0]).toEqual([sample(), { __rpc: "obj", id: 7 }]);
		// Shared and cyclic marker-bearing records take the graph decode path.
		const shared: Record<string, unknown> = { __rpc: "back", id: 3 };
		shared.self = shared;
		await target(shared, { ref: shared });
		const [graphFirst, graphSecond] = received[1] ?? [];
		expect(Reflect.get(graphFirst ?? {}, "__rpc")).toBe("back");
		expect(Reflect.get(graphFirst ?? {}, "self")).toBe(graphFirst);
		expect(Reflect.get(graphSecond ?? {}, "ref")).toBe(graphFirst);
	});

	it("rejects pending calls when the link closes", async () => {
		const { link } = await startFixture();
		const pending = link.call("hang");
		link.close("worker exited");
		await expect(pending).rejects.toBeInstanceOf(RpcClosedError);
	});
});
