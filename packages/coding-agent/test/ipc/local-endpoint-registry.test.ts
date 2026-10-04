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
import { rawRequest } from "../helpers/raw-request";

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

	it("rejects unsupported protocol versions without calling the handler or pruning live metadata", async () => {
		const source = { handle: () => ({ ok: true as const, secret: "must-not-leak" }) };
		const handler = vi.spyOn(source, "handle");
		const { registry, publication, meta } = await publish(() => source.handle());
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

	it("closes lingering clients idempotently and reads stale metadata without probing it", async () => {
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
		// A crash leaves metadata behind; reading does not probe or delete it.
		const metaPath = path.join(registry.dir, `${publication.entryId}.json`);
		await Bun.write(metaPath, JSON.stringify(meta));
		expect(await readLocalEndpointEntries(registry)).toEqual([{ entryId: publication.entryId, meta }]);
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

	it("skips an already-aborted query before opening a socket and leaves stale metadata untouched", async () => {
		const { registry, publication, meta } = await publish(() => ({ ok: true }));
		await publication.close();
		await Bun.write(path.join(registry.dir, `${publication.entryId}.json`), JSON.stringify(meta));
		const controller = new AbortController();
		controller.abort();
		const connect = vi.spyOn(net, "createConnection");
		expect(await queryLocalEndpoint(registry, meta, {}, 1500, controller.signal)).toEqual({
			status: "skip",
			error: "aborted",
		});
		expect(connect).not.toHaveBeenCalled();
		expect(
			await listLocalEndpoints(
				registry,
				entry => queryLocalEndpoint(registry, entry.meta, {}, 1500, controller.signal),
				{ signal: controller.signal },
			),
		).toEqual([]);
		expect(await readLocalEndpointEntries(registry)).toEqual([{ entryId: publication.entryId, meta }]);
	});

	it("aborts a connected query, closes its client, and permits later queries to the same live endpoint", async () => {
		const received = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { registry, meta } = await publish(async () => {
			received.resolve();
			await release.promise;
			return { ok: true, answer: 42 };
		});
		const controller = new AbortController();
		const connect = vi.spyOn(net, "createConnection");
		const query = queryLocalEndpoint(registry, meta, {}, 30_000, controller.signal);
		try {
			await received.promise;
			controller.abort();
			expect(await query).toEqual({ status: "skip", error: "aborted" });
			const socket = connect.mock.results[0]?.value;
			if (!(socket instanceof net.Socket)) throw new Error("Query did not create a client socket");
			expect(socket.destroyed).toBe(true);
			expect(await readLocalEndpointEntries(registry)).toHaveLength(1);
		} finally {
			release.resolve();
		}
		expect(await queryLocalEndpoint(registry, meta, {}, 1500)).toMatchObject({
			status: "ok",
			value: { answer: 42 },
		});
	});

	it("does not prune a dead probe result when cancellation wins the listing race", async () => {
		const { registry, publication, meta } = await publish(() => ({ ok: true }));
		const controller = new AbortController();
		expect(
			await listLocalEndpoints(
				registry,
				async () => {
					controller.abort();
					return { status: "dead" };
				},
				{ signal: controller.signal },
			),
		).toEqual([]);
		expect(await readLocalEndpointEntries(registry)).toEqual([{ entryId: publication.entryId, meta }]);
	});
});
