import { afterAll, beforeAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";

/**
 * TLS loopback endpoints for tests that count requests.
 *
 * The scheme picks the code path. Anthropic Messages leaves `fetch` for `node:https` (`coworkFetch`)
 * only over HTTPS; over `http` it falls back to the global fetch, a branch production never takes.
 * A request-count test whose endpoint speaks `http` can therefore report a clean result for a path
 * the product does not use. Serve with {@link LOOPBACK_TLS} and trust it with {@link trustLoopbackTls}.
 *
 * The certificate is self-signed, for `localhost` and 127.0.0.1, and is its own CA. Address the
 * endpoint as `localhost`: `node:https` refuses an IP address as the TLS server name, so an IP URL
 * fails in the client before anything is sent, and a "nothing arrived" case passes for the wrong
 * reason.
 */
export const LOOPBACK_CERT = `-----BEGIN CERTIFICATE-----
MIIBqzCCAVGgAwIBAgIUZP5pKaj4ef0paapVy+sQv6clqY8wCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MTAzMTAzNTExOVoYDzIxMjYxMDA3
MDM1MTE5WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAATl+ao50ypZF2OZT90HSltuzRGCmBlpZy335NDtACX8ydAHd9RDJvtN
njttzuWSsI1kHgG3NJ8GaTxmRKf5G9Z6o38wfTAdBgNVHQ4EFgQUPSXsO2rgG4+5
1nfbCArhe5aObSwwHwYDVR0jBBgwFoAUPSXsO2rgG4+51nfbCArhe5aObSwwGgYD
VR0RBBMwEYcEfwAAAYIJbG9jYWxob3N0MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0P
AQH/BAQDAgKEMAoGCCqGSM49BAMCA0gAMEUCIF1fit57CNChNw2nY6T5HD4dvrxV
zzxmgBp7k/5IoCPnAiEA3qVa+yQuR1Q1ck4MEJWSjYFkOoFah/bs3rWs7klHzs0=
-----END CERTIFICATE-----
`;

const LOOPBACK_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgVwM4d/P0wQ0/k2x9
wnBBUiftP1CAowrafv2w345OQ5WhRANCAATl+ao50ypZF2OZT90HSltuzRGCmBlp
Zy335NDtACX8ydAHd9RDJvtNnjttzuWSsI1kHgG3NJ8GaTxmRKf5G9Z6
-----END PRIVATE KEY-----
`;

/** `Bun.serve` options for a TLS endpoint on `localhost`; spread them into the server's options. */
export const LOOPBACK_TLS = {
	hostname: "localhost",
	tls: { cert: LOOPBACK_CERT, key: LOOPBACK_KEY },
} as const;

/** The origin of a server started with {@link LOOPBACK_TLS}. */
export function loopbackOrigin(server: { port?: number }): string {
	return `https://localhost:${server.port}`;
}

/**
 * Trust the loopback certificate for the calling test file, the way the product trusts a private
 * CA:
 *
 * - `NODE_EXTRA_CA_CERTS`, which every inference transport (`transportFetch`, the Anthropic client)
 *   reads per request;
 * - the default CA store, which `node:https` and `node:http2` read;
 * - for a plain `fetch` or `WebSocket` outside the transports (a tool's own request, Hindsight, MCP over
 *   HTTP, a live call's sideband), `NODE_TLS_REJECT_UNAUTHORIZED=0`: Bun's fetch and WebSocket read no
 *   CA at run time. The Anthropic client sets `rejectUnauthorized: true` itself, so its path still
 *   verifies the certificate.
 *
 * Everything is restored after the file's tests.
 */
export function trustLoopbackTls(): void {
	let dir: string | undefined;
	let savedExtraCa: string | undefined;
	let savedReject: string | undefined;
	let savedStore: string[] | undefined;
	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-loopback-tls-"));
		const certPath = path.join(dir, "loopback.pem");
		fs.writeFileSync(certPath, LOOPBACK_CERT);
		savedExtraCa = Bun.env.NODE_EXTRA_CA_CERTS;
		savedReject = Bun.env.NODE_TLS_REJECT_UNAUTHORIZED;
		savedStore = tls.getCACertificates("default");
		Bun.env.NODE_EXTRA_CA_CERTS = certPath;
		Bun.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
		tls.setDefaultCACertificates([...savedStore, LOOPBACK_CERT]);
	});
	afterAll(() => {
		if (savedStore) tls.setDefaultCACertificates(savedStore);
		if (savedExtraCa === undefined) delete Bun.env.NODE_EXTRA_CA_CERTS;
		else Bun.env.NODE_EXTRA_CA_CERTS = savedExtraCa;
		if (savedReject === undefined) delete Bun.env.NODE_TLS_REJECT_UNAUTHORIZED;
		else Bun.env.NODE_TLS_REJECT_UNAUTHORIZED = savedReject;
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	});
}
