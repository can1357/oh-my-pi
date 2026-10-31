/**
 * A process builds its auth broker client at startup, before any provider-request hold scope exists.
 * Each of the client's credential-bearing requests must still go through the global `fetch` as it is
 * when the request is made, so a held caller's broker request waits for its owner like every other
 * request instead of going out on a `fetch` captured before the hold wrapped it.
 *
 * The client is built while the global is Bun's native, unwrapped fetch, as at startup; entering the
 * first hold scope then wraps whatever the global is. The case waits real time because only a span of
 * silence at the endpoint shows that nothing was sent.
 */
import { afterAll, expect, it } from "bun:test";
import { AuthBrokerClient } from "@oh-my-pi/pi-ai/auth-broker";
import { runInRequestHoldScope } from "../src/request-hold";

const bearers: string[] = [];
const broker = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		bearers.push(request.headers.get("authorization") ?? "");
		return Response.json({ generatedAt: Date.now(), reports: [] });
	},
});
const fetchAtLoad = globalThis.fetch;
globalThis.fetch = Bun.fetch as typeof globalThis.fetch;
afterAll(() => {
	globalThis.fetch = fetchAtLoad;
	broker.stop(true);
});
const client = new AuthBrokerClient({
	url: broker.url.origin,
	token: "broker-bearer",
	maxRetries: 0,
	timeoutMs: 1_000,
});

it("sends nothing for a held caller, and one request for a live one", async () => {
	const held = new AbortController();
	const ended = new AbortController();
	held.abort();
	const heldCall = runInRequestHoldScope(held.signal, ended.signal, () => client.fetchUsage()).then(
		() => "answered",
		() => "refused",
	);
	// Entering the scope wrapped the global the client was built beside.
	const wrapperInstalledAfterClient = globalThis.fetch !== Bun.fetch;
	await Bun.sleep(150);
	const sentWhileHeld = bearers.length;
	ended.abort();
	const heldOutcome = await heldCall;
	await client.fetchUsage();

	expect({ wrapperInstalledAfterClient, sentWhileHeld, heldOutcome, bearers }).toEqual({
		wrapperInstalledAfterClient: true,
		sentWhileHeld: 0,
		heldOutcome: "refused",
		bearers: ["Bearer broker-bearer"],
	});
});
