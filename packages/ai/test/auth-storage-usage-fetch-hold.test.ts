/**
 * A process builds its `AuthStorage` at startup, before any provider-request hold scope exists. Its
 * usage and saved-reset requests must still go through the global `fetch` as it is when each request
 * is made, so a held caller's request waits for its owner like every other request instead of going
 * out on a `fetch` captured before the hold wrapped it.
 *
 * The storage is built while the global is an unwrapped fetch, as at startup; entering the first hold
 * scope then wraps whatever the global is. A Codex saved-reset listing runs in the caller's own
 * context (it is not shared work), through the storage's usage fetch, as in production: no
 * `usageFetch` is injected. Its host is fixed (`chatgpt.com`), so the unwrapped global sends each
 * request to a local HTTPS endpoint on `localhost` instead, with everything else unchanged. The case
 * waits real time because only a span of silence at the endpoint shows that nothing was sent.
 */
import { afterAll, expect, it } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { runInRequestHoldScope } from "../src/request-hold";
import { LOOPBACK_TLS, loopbackOrigin, trustLoopbackTls } from "./helpers/loopback-tls";

trustLoopbackTls();

const bearers: string[] = [];
const resets = Bun.serve({
	...LOOPBACK_TLS,
	port: 0,
	fetch(request) {
		bearers.push(request.headers.get("authorization") ?? "");
		return Response.json({ credits: [], available_count: 0 });
	},
});
const CODEX_ORIGIN = "https://chatgpt.com";
const fetchAtLoad = globalThis.fetch;
const toLoopback = ((input: string | URL | Request, init?: RequestInit) => {
	const url = input instanceof Request ? input.url : String(input);
	const routed = url.startsWith(CODEX_ORIGIN) ? `${loopbackOrigin(resets)}${url.slice(CODEX_ORIGIN.length)}` : url;
	return Bun.fetch(routed, init);
}) as typeof globalThis.fetch;
globalThis.fetch = toLoopback;
const storage = await AuthStorage.create(":memory:");
await storage.credentials.set("openai-codex", [
	{ type: "oauth", access: "codex-access", refresh: "codex-refresh", expires: Date.now() + 3_600_000, accountId: "a" },
]);
afterAll(() => {
	globalThis.fetch = fetchAtLoad;
	storage.close();
	resets.stop(true);
});

const list = () => storage.resets.list({ provider: "openai-codex" });

it("sends nothing for a held caller, and one request for a live one", async () => {
	const held = new AbortController();
	const ended = new AbortController();
	held.abort();
	const heldCall = runInRequestHoldScope(held.signal, ended.signal, list).then(
		statuses => (statuses[0]?.error ? "failed" : "answered"),
		() => "refused",
	);
	// Entering the scope wrapped the global the storage was built beside.
	const wrapperInstalledAfterStorage = globalThis.fetch !== toLoopback;
	await Bun.sleep(150);
	const sentWhileHeld = bearers.length;
	ended.abort();
	const heldOutcome = await heldCall;
	const live = await list();

	expect({
		wrapperInstalledAfterStorage,
		sentWhileHeld,
		heldOutcome,
		live: live.map(status => status.error ?? "ok"),
		bearers,
	}).toEqual({
		wrapperInstalledAfterStorage: true,
		sentWhileHeld: 0,
		heldOutcome: "failed",
		live: ["ok"],
		bearers: ["Bearer codex-access"],
	});
});
