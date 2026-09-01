import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { coworkFetch } from "@oh-my-pi/pi-ai/providers/cowork-fetch";

/**
 * `coworkFetch` runs on `node:https`, whose Bun shim ignores
 * `agent.createConnection` / `options.createConnection`. A CONNECT tunnel handed
 * to it is dropped and the request dials the provider directly, so a configured
 * proxy has to take the request off this transport entirely — otherwise every
 * `PI_PROXY` setting is a silent no-op for Anthropic inference.
 */
describe("coworkFetch proxy handling", () => {
	const nativeFetch = globalThis.fetch;
	let calls: Array<{ url: string; proxy: unknown }>;

	beforeEach(() => {
		calls = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({
				url: input instanceof Request ? input.url : String(input),
				proxy: (init as { proxy?: unknown } | undefined)?.proxy,
			});
			return new Response("ok");
		}) as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = nativeFetch;
	});

	it("delegates a proxied request to the global fetch, proxy option intact", async () => {
		const response = await coworkFetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
			proxy: "http://127.0.0.1:24560",
		} as RequestInit);

		expect(await response.text()).toBe("ok");
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
		expect(calls[0].proxy).toBe("http://127.0.0.1:24560");
	});

	it("delegates Request-object input to the global fetch", async () => {
		await coworkFetch(new Request("https://api.anthropic.com/v1/messages"));
		expect(calls).toHaveLength(1);
	});

	it("delegates non-https targets to the global fetch", async () => {
		await coworkFetch("http://api.anthropic.com/v1/messages", { headers: { accept: "*/*" } });
		expect(calls).toHaveLength(1);
	});

	it("keeps unproxied https requests on the cowork transport", async () => {
		// Unreachable loopback port: reaching the node:https path fails to connect
		// instead of delegating, which is what proves the request stayed here.
		await expect(coworkFetch("https://127.0.0.1:1/v1/messages", { headers: { accept: "*/*" } })).rejects.toThrow();
		expect(calls).toHaveLength(0);
	});
});
