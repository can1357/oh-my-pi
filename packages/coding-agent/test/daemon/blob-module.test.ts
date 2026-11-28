/**
 * Contract of the daemon `blob` module (image URL broker) over a real daemon
 * in a private runtime dir. Units use the `direct` exposure: the unit's own
 * HTTP server on loopback, no tunnel binary and no network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	BLOB_APPEND_METHOD,
	BLOB_BROKER_KIND,
	BLOB_CALL_CHUNK_CHARS,
	BLOB_RENDER_CHANNEL,
	type BlobBrokerWorkerConfig,
	type BlobRenderRequest,
	type BlobUnitParams,
	blobBrokerConfigKey,
	type EnsureBlobResponse,
} from "@oh-my-pi/pi-coding-agent/blob-broker/protocol";
import { canonicalProjectDir, daemonClient, isolateDaemonForSmokeTest } from "@oh-my-pi/pi-coding-agent/daemon/client";
import { type DaemonClient, type DaemonTunnel, projectScope } from "@oh-my-pi/pi-coding-agent/daemon/protocol";
import { TempDir } from "@oh-my-pi/pi-utils";

const DAEMON_TEST_TIMEOUT_MS = 60_000;
const WAIT_MS = 15_000;
const HEALTH_PATH = "/.well-known/omp-blob-health";

/** Teardown never waits on how fast a process exits: whatever is still running is gone after this. */
function killQuietly(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already exited.
	}
}

async function until<T>(what: string, probe: () => T | undefined | Promise<T | undefined>): Promise<T> {
	const deadline = Date.now() + WAIT_MS;
	while (true) {
		const value = await probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		// Polls another process (the daemon); there is no in-process signal to await.
		await Bun.sleep(20);
	}
}

let restoreDaemon: (() => Promise<void>) | undefined;
let project: TempDir | undefined;
let projectDir = "";
/** Stands in for a public base URL: answers the exposure health probe the unit runs at start. */
let publicOrigin: Bun.Server<undefined> | undefined;
const tunnels: DaemonTunnel[] = [];
const daemonPids = new Set<number>();

beforeEach(async () => {
	restoreDaemon = await isolateDaemonForSmokeTest();
	project = TempDir.createSync("@omp-blob-module-");
	projectDir = await canonicalProjectDir(project.path());
});

afterEach(async () => {
	for (const tunnel of tunnels.splice(0)) tunnel.close();
	await restoreDaemon?.();
	restoreDaemon = undefined;
	publicOrigin?.stop(true);
	publicOrigin = undefined;
	for (const pid of daemonPids) killQuietly(pid);
	daemonPids.clear();
	await project?.remove();
	project = undefined;
});

async function daemon(): Promise<DaemonClient> {
	const client = await daemonClient();
	daemonPids.add(client.welcome.daemon.pid);
	return client;
}

function startPublicOrigin(): string {
	publicOrigin = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: request => new Response(null, { status: new URL(request.url).pathname === HEALTH_PATH ? 204 : 404 }),
	});
	return `http://127.0.0.1:${publicOrigin.port}`;
}

function directConfig(overrides: Partial<BlobBrokerWorkerConfig> = {}): BlobBrokerWorkerConfig {
	return { kind: "direct", options: {}, credentials: {}, bindHost: "127.0.0.1", ...overrides };
}

async function openUnit(
	client: DaemonClient,
	config: BlobBrokerWorkerConfig,
	extra: Pick<BlobUnitParams, "renderTimeoutMs"> = {},
): Promise<string> {
	const params: BlobUnitParams = {
		config,
		spawn: { env: { PATH: process.env.PATH ?? "" }, cwd: projectDir },
		...extra,
	};
	const opened = await client.open({
		kind: BLOB_BROKER_KIND,
		scope: projectScope(projectDir),
		key: blobBrokerConfigKey(config),
		params,
	});
	return opened.unit.id;
}

async function publish(client: DaemonClient, unit: string, key: string, bytes: Uint8Array): Promise<string> {
	const response = await client.call<EnsureBlobResponse>(
		BLOB_BROKER_KIND,
		"blob",
		{ key, mimeType: "image/png", data: bytes.toBase64() },
		{ unit },
	);
	const url = response.publication?.url;
	if (!url) throw new Error(`blob ${key} was not published: ${JSON.stringify(response)}`);
	return url;
}

async function fetchBytes(url: string): Promise<{ status: number; bytes: Uint8Array }> {
	const response = await fetch(url);
	return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
}

/** Session side of a `render` tunnel that records the unit's render requests. */
async function openRenderTunnel(client: DaemonClient, unit: string) {
	const tunnel = await client.attach(unit, BLOB_RENDER_CHANNEL);
	tunnels.push(tunnel);
	const owner = crypto.randomUUID();
	const requests: BlobRenderRequest[] = [];
	let buffered = "";
	const decoder = new TextDecoder();
	tunnel.start(
		chunk => {
			buffered += decoder.decode(chunk, { stream: true });
			let newline = buffered.indexOf("\n");
			while (newline >= 0) {
				const line = buffered.slice(0, newline).trim();
				buffered = buffered.slice(newline + 1);
				newline = buffered.indexOf("\n");
				if (line) requests.push(JSON.parse(line) as BlobRenderRequest);
			}
		},
		() => {},
	);
	tunnel.send(`${JSON.stringify({ owner })}\n`);
	return { tunnel, owner, requests };
}

/** Register lazy blob `key` for `owner`, retrying until the unit has read the tunnel's hello. */
function registerLazy(client: DaemonClient, unit: string, key: string, owner: string): Promise<string> {
	return until(`lazy registration of ${key}`, async () => {
		try {
			const response = await client.call<EnsureBlobResponse>(
				BLOB_BROKER_KIND,
				"lazy",
				{ key, mimeType: "image/png", owner },
				{ unit },
			);
			return response.publication?.url;
		} catch (error) {
			if (error instanceof Error && error.message.includes("no render tunnel attached")) return undefined;
			throw error;
		}
	});
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe("daemon blob module", () => {
	test(
		"units for two different configs in one project coexist and both keep serving",
		async () => {
			const client = await daemon();
			const first = await openUnit(client, directConfig({ options: { tag: "a" } }));
			const firstUrl = await publish(client, first, "key-a", PNG);
			const second = await openUnit(client, directConfig({ options: { tag: "b" } }));
			const secondUrl = await publish(client, second, "key-b", PNG.toReversed());

			expect(second).not.toBe(first);
			const { units } = await client.request({
				op: "list",
				scope: projectScope(projectDir),
				kind: BLOB_BROKER_KIND,
			});
			expect(
				units
					.filter(unit => unit.state === "ready")
					.map(unit => unit.id)
					.sort(),
			).toEqual([first, second].sort());
			expect(await fetchBytes(firstUrl)).toEqual({ status: 200, bytes: PNG });
			expect(await fetchBytes(secondUrl)).toEqual({ status: 200, bytes: PNG.toReversed() });
		},
		DAEMON_TEST_TIMEOUT_MS,
	);

	test(
		"the blob call returns one stable URL per key, including for a bytes-less probe",
		async () => {
			const client = await daemon();
			const unit = await openUnit(client, directConfig());
			const url = await publish(client, unit, "same-key", PNG);
			const again = await publish(client, unit, "same-key", PNG);
			const probe = await client.call<EnsureBlobResponse>(
				BLOB_BROKER_KIND,
				"blob",
				{ key: "same-key", mimeType: "image/png" },
				{ unit },
			);
			const other = await publish(client, unit, "other-key", PNG);

			expect(again).toBe(url);
			expect(probe.publication?.url).toBe(url);
			expect(other).not.toBe(url);
		},
		DAEMON_TEST_TIMEOUT_MS,
	);

	test(
		"a payload above one call's slice budget uploads through append slices and round-trips byte-identical",
		async () => {
			const client = await daemon();
			const unit = await openUnit(client, directConfig());
			const bytes = new Uint8Array(3.5 * 1024 * 1024);
			for (let offset = 0; offset < bytes.length; offset += 65_536) {
				crypto.getRandomValues(bytes.subarray(offset, offset + 65_536));
			}
			const data = bytes.toBase64();
			expect(data.length).toBeGreaterThan(BLOB_CALL_CHUNK_CHARS);

			const upload = crypto.randomUUID();
			for (let offset = 0; offset < data.length; offset += BLOB_CALL_CHUNK_CHARS) {
				await client.call(
					BLOB_BROKER_KIND,
					BLOB_APPEND_METHOD,
					{ upload, data: data.slice(offset, offset + BLOB_CALL_CHUNK_CHARS) },
					{ unit },
				);
			}
			const response = await client.call<EnsureBlobResponse>(
				BLOB_BROKER_KIND,
				"blob",
				{ key: "large", mimeType: "image/png", upload },
				{ unit },
			);
			const fetched = await fetchBytes(response.publication?.url ?? "");

			expect(fetched.status).toBe(200);
			expect(fetched.bytes.length).toBe(bytes.length);
			expect(Buffer.from(fetched.bytes).equals(Buffer.from(bytes))).toBe(true);
		},
		DAEMON_TEST_TIMEOUT_MS,
	);

	test(
		"a lazy blob renders on fetch through the owner's render tunnel",
		async () => {
			const client = await daemon();
			const unit = await openUnit(client, directConfig());
			const render = await openRenderTunnel(client, unit);
			const url = await registerLazy(client, unit, "lazy-ok", render.owner);

			const fetched = fetchBytes(url);
			const request = await until("render request", () => render.requests[0]);
			expect(request.key).toBe("lazy-ok");
			render.tunnel.send(`${JSON.stringify({ id: request.id, mime: "image/png", base64: PNG.toBase64() })}\n`);

			expect(await fetched).toEqual({ status: 200, bytes: PNG });
		},
		DAEMON_TEST_TIMEOUT_MS,
	);

	test(
		"a lazy fetch fails as gone, without waiting out the render timeout, when the owner's tunnel closes mid-render",
		async () => {
			const client = await daemon();
			const unit = await openUnit(client, directConfig());
			const render = await openRenderTunnel(client, unit);
			const url = await registerLazy(client, unit, "lazy-disconnect", render.owner);

			const started = Date.now();
			const fetched = fetchBytes(url);
			await until("render request", () => render.requests[0]);
			render.tunnel.close();

			expect((await fetched).status).toBe(410);
			expect(Date.now() - started).toBeLessThan(20_000);
		},
		DAEMON_TEST_TIMEOUT_MS,
	);

	test(
		"a lazy fetch whose owner never answers the render request times out as gone",
		async () => {
			const client = await daemon();
			const unit = await openUnit(client, directConfig(), { renderTimeoutMs: 1_000 });
			const render = await openRenderTunnel(client, unit);
			const url = await registerLazy(client, unit, "lazy-timeout", render.owner);

			const started = Date.now();
			const fetched = fetchBytes(url);
			await until("render request", () => render.requests[0]);

			expect((await fetched).status).toBe(410);
			expect(Date.now() - started).toBeGreaterThanOrEqual(900);
		},
		DAEMON_TEST_TIMEOUT_MS,
	);

	test(
		"credentials in the public base URL never appear in the unit's board label",
		async () => {
			const client = await daemon();
			const origin = startPublicOrigin();
			const unit = await openUnit(
				client,
				directConfig({ publicBaseUrl: origin.replace("//", "//omp-user:s3cret@") }),
			);

			const { unit: snapshot } = await client.request({ op: "describe", unit });
			const { units } = await client.request({ op: "list", kind: BLOB_BROKER_KIND });
			const listed = units.find(candidate => candidate.id === unit);

			expect(snapshot.label).toContain(origin.slice("http://".length));
			for (const label of [snapshot.label, listed?.label ?? ""]) {
				expect(label).not.toContain("s3cret");
				expect(label).not.toContain("omp-user");
			}
		},
		DAEMON_TEST_TIMEOUT_MS,
	);

	test(
		"a stopped unit persists its URL index so the reopened unit serves the same URL without the bytes",
		async () => {
			const client = await daemon();
			const persistDir = path.join(projectDir, "blob-state");
			await fs.mkdir(persistDir, { recursive: true });
			const config = directConfig({
				publicBaseUrl: startPublicOrigin(),
				persist: {
					blobsDir: path.join(persistDir, "blobs"),
					indexPath: path.join(persistDir, "index.json"),
					savingsPath: path.join(persistDir, "savings.jsonl"),
					ttlMs: 0,
				},
			});
			const first = await openUnit(client, config);
			const url = await publish(client, first, "persisted", PNG);
			const stopped = await client.request({ op: "stop", unit: first, timeoutMs: 10_000 });
			expect(["exited", "failed"]).toContain(stopped.unit.state);

			const reopened = await openUnit(client, config);
			const probe = await client.call<EnsureBlobResponse>(
				BLOB_BROKER_KIND,
				"blob",
				{ key: "persisted", mimeType: "image/png" },
				{ unit: reopened },
			);

			expect(probe).toEqual({ publication: expect.objectContaining({ url }) });
		},
		DAEMON_TEST_TIMEOUT_MS,
	);
});
