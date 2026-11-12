import { type MessagePort, parentPort } from "node:worker_threads";
import { type RemoteObject, type RpcFrame, RpcLink, type RpcMethod } from "../../src/thread/rpc";

/** Protocol of the main-thread `Counter` class exported to the fixture. */
export type CounterProtocol = {
	increment: RpcMethod<[number], void>;
	value: RpcMethod<[], number>;
};

/** Methods the test's main thread serves. */
export type FixtureMainApi = {
	add: RpcMethod<[number, number], number>;
	log: RpcMethod<[string], void>;
	entries: RpcMethod<[], string[]>;
	fail: RpcMethod<[], never>;
	echoToken: RpcMethod<[unknown], unknown>;
	echo: RpcMethod<[unknown], unknown>;
	callBack: RpcMethod<[(value: number) => number], number>;
};

/** Methods the fixture worker serves. */
export type FixtureWorkerApi = {
	syncAfterNotify: RpcMethod<[], string[]>;
	syncAdd: RpcMethod<[number, number], number>;
	waitForAbort: RpcMethod<[AbortSignal], { name: string; message: string }>;
	callMainFailure: RpcMethod<[], { name: string; message: string; errorId?: unknown; idEnumerable?: boolean }>;
	callbackKind: RpcMethod<[(value: number) => number], "sync" | "async">;
	accept: RpcMethod<[unknown], void>;
	passCallback: RpcMethod<[], number>;
	tokenRoundTrip: RpcMethod<[], boolean>;
	hang: RpcMethod<[], never>;
	bumpCounter: RpcMethod<[unknown], { value: number; sameOnMain: boolean }>;
	returnArg: RpcMethod<[unknown], unknown>;
};

class RemoteCounter {
	constructor(readonly remote: RemoteObject<CounterProtocol>) {}
}

class Token {
	constructor(readonly id: string) {}
}

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");

port.once("message", (init: { sync: MessagePort; counter: SharedArrayBuffer }) => {
	const link = new RpcLink<FixtureWorkerApi, FixtureMainApi>(
		{
			send: frame => port.postMessage(frame),
			listen: handler => {
				const listener = (frame: RpcFrame): void => handler(frame);
				port.on("message", listener);
				return () => port.off("message", listener);
			},
		},
		{ name: "fixture", sync: { port: init.sync, counter: new Int32Array(init.counter) } },
	);
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
	link.handle("syncAfterNotify", () => {
		link.notify("log", "first");
		link.notify("log", "second");
		return link.callSync("entries");
	});
	link.handle("syncAdd", (a, b) => link.callSync("add", a, b));
	link.handle("waitForAbort", signal => {
		const { promise, resolve } = Promise.withResolvers<{ name: string; message: string }>();
		signal.addEventListener("abort", () => {
			const reason: unknown = signal.reason;
			resolve(
				reason instanceof Error
					? { name: reason.name, message: reason.message }
					: { name: "unknown", message: String(reason) },
			);
		});
		return promise;
	});
	link.handle("callMainFailure", async () => {
		try {
			await link.call("fail");
			return { name: "none", message: "" };
		} catch (error) {
			return error instanceof Error
				? {
						name: error.name,
						message: error.message,
						errorId: Reflect.get(error, "errorId"),
						idEnumerable: Object.keys(error).includes("errorId"),
					}
				: { name: "unknown", message: String(error) };
		}
	});
	link.handle("callbackKind", callback => {
		const result: unknown = callback(1);
		if (result instanceof Promise) {
			result.catch(() => {});
			return "async";
		}
		return result === 2 ? "sync" : "async";
	});
	link.handle("accept", () => {});
	link.handle("passCallback", () => link.call("callBack", value => value * 10));
	link.handle("tokenRoundTrip", async () => {
		const token = new Token("a");
		tokens.set("a", token);
		const echoed = await link.call("echoToken", token);
		return echoed === token;
	});
	link.handle("hang", () => Promise.withResolvers<never>().promise);
	link.importClass<RemoteCounter, CounterProtocol>("counter", remote => new RemoteCounter(remote));
	link.handle("bumpCounter", async counter => {
		if (!(counter instanceof RemoteCounter)) throw new Error("expected a counter proxy");
		counter.remote.notify("increment", 2);
		await counter.remote.call("increment", 3);
		const value = counter.remote.callSync("value");
		const sameOnMain = (await link.call("echo", counter)) === counter;
		return { value, sameOnMain };
	});
	link.handle("returnArg", value => value);
	port.postMessage({ ready: true });
});
