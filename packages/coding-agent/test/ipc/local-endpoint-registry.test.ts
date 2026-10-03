import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
	listLocalEndpoints,
	type LocalEndpointHandler,
	type LocalEndpointMetadata,
	type LocalEndpointPublication,
	type LocalEndpointRegistry,
	publishLocalEndpoint,
	queryLocalEndpoint,
	readLocalEndpointEntries,
} from "@oh-my-pi/pi-coding-agent/ipc/local-endpoint-registry";

const directories: string[] = [];
const publications: LocalEndpointPublication[] = [];
const clients: net.Socket[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const client of clients.splice(0)) client.destroy();
	for (const publication of publications.splice(0)) await publication.close();
	for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function publish(handler: LocalEndpointHandler): Promise<{
	registry: LocalEndpointRegistry;
	publication: LocalEndpointPublication;
	meta: LocalEndpointMetadata;
}> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-endpoint-"));
	directories.push(dir);
	const registry: LocalEndpointRegistry = {
		dir,
		pipePrefix: "omp-endpoint-test",
		version: 1,
		maxRequestBytes: 4096,
		maxResponseBytes: 4096,
	};
	const publication = await publishLocalEndpoint(registry, handler, { instanceId: "generic-endpoint" });
	publications.push(publication);
	const [entry] = await readLocalEndpointEntries(registry);
	if (!entry) throw new Error("Publication is not discoverable");
	expect(entry.entryId).toBe(publication.entryId);
	return { registry, publication, meta: entry.meta };
}

/** One raw request, including invalid JSON/version envelopes that the query helper prevents. */
function rawRequest(endpoint: string, line: string): Promise<Record<string, unknown> | null> {
	const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown> | null>();
	const socket = net.createConnection({ path: endpoint });
	clients.push(socket);
	let buffer = "";
	socket.setEncoding("utf8");
	socket.once("error", reject);
	socket.once("connect", () => socket.write(line));
	socket.on("data", chunk => {
		buffer += chunk;
		const newline = buffer.indexOf("\n");
		if (newline < 0) return;
		try {
			resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
		} catch (err) {
			reject(err);
		}
		socket.destroy();
	});
	socket.once("close", () => resolve(null));
	return promise;
}

describe("local endpoint registry", () => {
	it("publishes an authenticated endpoint and protects the protocol fields from request and handler overrides", async () => {
		const source = {
			handle(request: Readonly<Record<string, unknown>>) {
				return { ok: true as const, v: 99, doubled: Number(request.value) * 2 };
			},
		};
		const handler = vi.spyOn(source, "handle");
		const { registry, publication, meta } = await publish(request => source.handle(request));
		expect(await queryLocalEndpoint(registry, meta, { value: 21, v: 99, token: "forged" }, 1500)).toEqual({
			status: "ok",
			value: { ok: true, v: 1, doubled: 42 },
		});
		expect(handler).toHaveBeenCalledWith({ value: 21, v: 1, token: meta.token });
		expect(
			await listLocalEndpoints(registry, entry => queryLocalEndpoint(registry, entry.meta, { value: 4 }, 1500)),
		).toEqual([{ entry: { entryId: publication.entryId, meta }, value: { ok: true, v: 1, doubled: 8 } }]);
	});

	it("rejects invalid authentication and protocol versions without calling the handler or pruning live metadata", async () => {
		const source = { handle: () => ({ ok: true as const, secret: "must-not-leak" }) };
		const handler = vi.spyOn(source, "handle");
		const { registry, publication, meta } = await publish(() => source.handle());
		expect(await queryLocalEndpoint(registry, { ...meta, token: "wrong-token" }, {}, 1500)).toEqual({
			status: "skip",
			error: "authentication_failed",
		});
		expect(await rawRequest(publication.endpoint, `${JSON.stringify({ v: 2, token: meta.token })}\n`)).toEqual({
			ok: false,
			v: 1,
			error: "unsupported_protocol",
		});
		expect(await queryLocalEndpoint(registry, { ...meta, version: 2 }, {}, 1500)).toEqual({
			status: "skip",
			error: "unsupported_protocol",
		});
		expect(handler).not.toHaveBeenCalled();
		expect(await readLocalEndpointEntries(registry)).toEqual([{ entryId: publication.entryId, meta }]);
	});

	it("returns handler_failed for a rejected asynchronous handler without exposing its exception", async () => {
		const source = { handle: async () => ({ ok: true as const }) };
		vi.spyOn(source, "handle").mockRejectedValue(new Error("private capability must not leak"));
		const { registry, meta } = await publish(() => source.handle());
		expect(await queryLocalEndpoint(registry, meta, {}, 1500)).toEqual({ status: "skip", error: "handler_failed" });
		expect(await listLocalEndpoints(registry, entry => queryLocalEndpoint(registry, entry.meta, {}, 1500))).toEqual(
			[],
		);
		expect(await readLocalEndpointEntries(registry)).toHaveLength(1);
	});

	it("closes lingering clients, withdraws artifacts idempotently, and prunes dead metadata even when its PID is alive", async () => {
		const received = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { registry, publication, meta } = await publish(async () => {
			received.resolve();
			await release.promise;
			return { ok: true };
		});
		const client = net.createConnection({ path: publication.endpoint });
		clients.push(client);
		client.once("connect", () => client.write(`${JSON.stringify({ v: registry.version, token: meta.token })}\n`));
		client.once("error", err => received.reject(err));
		const disconnected = Promise.withResolvers<void>();
		client.once("close", () => disconnected.resolve());
		try {
			// The handler signal proves the server has accepted this lingering client.
			await received.promise;
			await Promise.all([publication.close(), publication.close()]);
			await disconnected.promise;
		} finally {
			release.resolve();
		}
		expect(await readLocalEndpointEntries(registry)).toEqual([]);
		expect(await queryLocalEndpoint(registry, meta, {}, 1500)).toEqual({ status: "dead" });
		if (process.platform !== "win32") {
			await expect(fs.stat(publication.endpoint)).rejects.toMatchObject({ code: "ENOENT" });
		}

		// A crash leaves metadata behind; reading does not probe or delete it.
		const metaPath = path.join(registry.dir, `${publication.entryId}.json`);
		await Bun.write(metaPath, JSON.stringify(meta));
		expect(await readLocalEndpointEntries(registry)).toEqual([{ entryId: publication.entryId, meta }]);
		expect(await listLocalEndpoints(registry, entry => queryLocalEndpoint(registry, entry.meta, {}, 1500))).toEqual(
			[],
		);
		expect(await Bun.file(metaPath).exists()).toBe(false);
	});

	it("rejects malformed and oversized requests and dispatches at most one request per connection", async () => {
		const source = { handle: async () => ({ ok: true as const, answer: 42 }) };
		const handler = vi.spyOn(source, "handle");
		const { registry, publication, meta } = await publish(() => source.handle());
		expect(await rawRequest(publication.endpoint, "{broken\n")).toEqual({
			ok: false,
			v: 1,
			error: "malformed_request",
		});
		expect(await rawRequest(publication.endpoint, `${"x".repeat(registry.maxRequestBytes + 1)}\n`)).toBeNull();
		expect(handler).not.toHaveBeenCalled();
		const line = `${JSON.stringify({ v: 1, token: meta.token })}\n`;
		expect(await rawRequest(publication.endpoint, line + line)).toEqual({ ok: true, v: 1, answer: 42 });
		expect(handler).toHaveBeenCalledTimes(1);
	});
});
