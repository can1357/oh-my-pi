import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";
import {
	__cursorH2ConnectingSnapshot,
	__cursorH2PoolSnapshot,
	acquireCursorH2,
	disposeCursorH2Pool,
} from "../../src/providers/cursor/h2-pool";

// Isolated replica of the synchronous http2.connect-throw scenario: the
// proxy env vars are process-global, so the mutation happens in this child
// process instead of the parent test runner (pattern: cursor-proxy-env.ts).
//
// A CONNECT proxy that relays to a local TLS/h2 server lets the tunnel
// complete and negotiate h2 ALPN. The baseUrl uses an ftp: scheme so
// `http2.connect(baseUrl, { createConnection })` throws synchronously after
// the tunneled socket is live but before `session` is assigned. The
// establishment-scope fallback must destroy that socket; no pool entry or
// connecting reservation may survive.

const RUN_PATH = "/agent.v1.AgentService/Run";
const provider = "cursor-h2-proxy-sync-throw-test";
const envKey = `PI_PROXY_${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

// --- Self-signed cert for the TLS/h2 backend ---
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "h2-sync-throw-"));
const keyPath = path.join(tmpDir, "key.pem");
const certPath = path.join(tmpDir, "cert.pem");
execSync(
	`openssl req -x509 -newkey rsa:2048 -keyout ${keyPath} -out ${certPath} -days 1 -nodes -subj "/CN=cursor.example.invalid" 2>/dev/null`,
);
const key = fs.readFileSync(keyPath, "utf8");
const cert = fs.readFileSync(certPath, "utf8");

// --- TLS backend with h2 ALPN (just accepts and holds the socket) ---
const tlsServer = tls.createServer({ key, cert, ALPNProtocols: ["h2"] });
const tlsSockets = new Set<tls.TLSSocket>();
tlsServer.on("secureConnection", sock => {
	tlsSockets.add(sock);
	sock.on("close", () => tlsSockets.delete(sock));
	sock.resume();
});
const tlsListening = Promise.withResolvers<void>();
tlsServer.once("error", tlsListening.reject);
tlsServer.listen(0, "127.0.0.1", () => tlsListening.resolve());
await tlsListening.promise;
const tlsPort = (tlsServer.address() as net.AddressInfo).port;

// --- CONNECT proxy that relays to the local TLS backend ---
// Tracks the client-side socket (the one connectProxiedSocket's raw socket
// connects to). When the tunneled TLSSocket is destroyed, its underlying raw
// socket is destroyed, which destroys this client-side socket. If the
// TLSSocket leaks, this socket stays open.
let clientSocket: net.Socket | undefined;
const proxy = net.createServer(clientSock => {
	// Track the client-side socket: its destruction mirrors the tunneled
	// TLSSocket's destruction on the h2-pool side.
	clientSocket = clientSock;
	// Read the CONNECT request, then relay raw bytes to the TLS backend.
	// No setEncoding: TLS ClientHello must reach the backend as raw Buffer.
	let buf = Buffer.alloc(0);
	clientSock.on("data", (chunk: Buffer) => {
		buf = Buffer.concat([buf, chunk]);
		const idx = buf.toString("binary").indexOf("\r\n\r\n");
		if (idx === -1) return;
		clientSock.removeAllListeners("data");
		clientSock.write("HTTP/1.1 200 Connection Established\r\n\r\n");

		const backend = net.connect({ host: "127.0.0.1", port: tlsPort });
		backend.on("error", () => clientSock.destroy());
		clientSock.on("error", () => backend.destroy());
		backend.on("connect", () => {
			const leftover = buf.subarray(idx + 4);
			if (leftover.length > 0) backend.write(leftover);
			backend.pipe(clientSock);
			clientSock.pipe(backend);
		});
		backend.on("close", () => clientSock.destroy());
		clientSock.on("close", () => backend.destroy());
	});
	clientSock.on("error", () => {
		/* client disconnected */
	});
});
const proxyListening = Promise.withResolvers<void>();
proxy.once("error", proxyListening.reject);
proxy.listen(0, "127.0.0.1", () => proxyListening.resolve());
await proxyListening.promise;
const proxyPort = (proxy.address() as net.AddressInfo).port;

Bun.env[envKey] = `http://127.0.0.1:${proxyPort}`;
Bun.env.NO_PROXY = "";
Bun.env.no_proxy = "";
// The TLS backend uses a self-signed cert; connectProxiedSocket does not
// pass rejectUnauthorized:false, so disable cert verification for the
// tunnel's TLS overlay in this isolated child process only.
Bun.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// ftp: scheme → http2.connect throws synchronously after the tunnel succeeds.
// The target host:port (cursor.example.invalid:443) is non-local so the proxy
// is not bypassed; the CONNECT proxy relays to the local TLS backend
// regardless of the requested host.
const acquirer = acquireCursorH2({
	baseUrl: "ftp://cursor.example.invalid:443",
	requestPath: RUN_PATH,
	headers: {},
	provider,
}).catch(e => e);

// Wait for the client-side socket to appear (proxy accepted the CONNECT).
const deadline = Date.now() + 5000;
while (clientSocket === undefined && Date.now() < deadline) {
	await Bun.sleep(5);
}
if (clientSocket === undefined) throw new Error("client socket never appeared");

// Give the acquisition time to settle (http2.connect throws, rejection arm
// runs, tunneled socket is destroyed).
const result = await acquirer;

// Give the rejection arm time to run. Wait for the client-side socket to be
// destroyed — it mirrors the tunneled TLSSocket's destruction. Pre-fix the
// TLSSocket leaked and this socket stayed open because the TLS backend holds
// its connection open indefinitely (no h2 preface is ever sent, so the
// backend never closes).
const socketDestroyedBeforeCleanup = await Promise.race([
	(async () => {
		const destroyDeadline = Date.now() + 3000;
		while (clientSocket?.destroyed === false && Date.now() < destroyDeadline) {
			await Bun.sleep(5);
		}
		return clientSocket?.destroyed === true;
	})(),
	(async () => {
		await Bun.sleep(3000);
		return false;
	})(),
]);

const poolEmptyAfterAcquire = __cursorH2PoolSnapshot().length === 0;
const connectingEmptyAfterAcquire = __cursorH2ConnectingSnapshot().length === 0;

// Cleanup
for (const sock of tlsSockets) sock.destroy();
tlsServer.close();
proxy.close();
fs.rmSync(tmpDir, { recursive: true });
await disposeCursorH2Pool();

process.stdout.write(
	`${JSON.stringify({
		acquisitionRejected: result instanceof Error,
		socketDestroyed: socketDestroyedBeforeCleanup,
		poolEmptyAfterAcquire,
		connectingEmptyAfterAcquire,
	})}\n`,
);
