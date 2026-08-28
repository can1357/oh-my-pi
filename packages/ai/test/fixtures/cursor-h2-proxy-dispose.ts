import * as net from "node:net";
import { __cursorH2PoolSnapshot, acquireCursorH2, disposeCursorH2Pool } from "../../src/providers/cursor/h2-pool";

// Isolated replica of the silent-proxy dispose scenario: the proxy env vars
// are process-global, so the mutation happens in this child process instead
// of the parent test runner (pattern: cursor-proxy-env.ts). A CONNECT proxy
// that accepts TCP but never replies keeps the establishment's tunnel stage
// pending indefinitely; disposal must abort it. Each teardown observation is
// printed for the parent test to assert.
const RUN_PATH = "/agent.v1.AgentService/Run";
const provider = "cursor-h2-proxy-dispose-test";
const envKey = `PI_PROXY_${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

let proxySocket: net.Socket | undefined;
const proxy = net.createServer(sock => {
	proxySocket = sock;
	// Flow the socket so the peer's teardown (FIN / close) is processed and
	// `destroyed` flips true — on a paused socket Node never advances the
	// stream state and the observation below would be a false negative.
	sock.resume();
});
const listening = Promise.withResolvers<void>();
proxy.once("error", listening.reject);
proxy.listen(0, "127.0.0.1", () => listening.resolve());
await listening.promise;
const address = proxy.address();
const port = typeof address === "object" && address !== null ? address.port : 0;

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await Bun.sleep(5);
	}
}

Bun.env[envKey] = `http://127.0.0.1:${port}`;
Bun.env.NO_PROXY = "";
Bun.env.no_proxy = "";

// The establishment hangs in the tunnel stage (waiting for a CONNECT reply
// the silent proxy never sends).
const acquirer = acquireCursorH2({
	baseUrl: "https://cursor.example.invalid",
	requestPath: RUN_PATH,
	headers: {},
	provider,
}).catch(e => e);
await waitFor(() => proxySocket !== undefined, 2000);
// The pre-disposal tunnel is live: the peer accepted the CONNECT.
const tunnelLiveBeforeDispose = proxySocket?.destroyed === false;

// Disposal must abort the tunnel and resolve within a bounded watchdog —
// NOT return while the pre-disposal tunnel keeps running into its own 30s
// timeout.
const disposed = await Promise.race([
	disposeCursorH2Pool().then(() => true),
	(() => {
		const { promise, resolve } = Promise.withResolvers<false>();
		setTimeout(() => resolve(false), 3000);
		return promise;
	})(),
]);

// Disposal's cancellation tore the still-resolving tunnel's socket down.
await waitFor(() => proxySocket?.destroyed === true, 2000);
const poolEmptyAfterDispose = __cursorH2PoolSnapshot().length === 0;

await acquirer;
const poolEmptyAfterAcquirer = __cursorH2PoolSnapshot().length === 0;

try {
	proxy.close();
} finally {
	process.stdout.write(
		`${JSON.stringify({
			tunnelLiveBeforeDispose,
			disposed,
			socketDestroyedAfterDispose: proxySocket?.destroyed === true,
			poolEmptyAfterDispose,
			poolEmptyAfterAcquirer,
		})}\n`,
	);
}
