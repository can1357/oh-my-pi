import { afterEach, describe, expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	handleLocalEndpointRequest,
	type LocalEndpointPublication,
	type LocalEndpointRegistry,
	listLocalEndpoints,
	publishLocalEndpoint,
	queryLocalEndpoint,
	readLocalEndpointEntries,
} from "../../src/ipc/local-endpoint-registry";

const publications: LocalEndpointPublication[] = [];
const directories: TempDir[] = [];

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const publication of publications.splice(0)) await publication.close();
	for (const dir of directories.splice(0)) dir[Symbol.dispose]();
});

function registry(): LocalEndpointRegistry {
	const dir = TempDir.createSync("@omp-endpoints-");
	directories.push(dir);
	return { dir: dir.path(), pipePrefix: "omp-test", version: 1, maxRequestBytes: 4096, maxResponseBytes: 65536 };
}

async function publish(reg: LocalEndpointRegistry): Promise<LocalEndpointPublication> {
	const token = crypto.randomBytes(32).toString("hex");
	const publication = await publishLocalEndpoint(
		reg,
		socket => {
			handleLocalEndpointRequest(socket, reg, token, () => ({ ok: true, answer: "hello" }));
		},
		{ extra: { token } },
	);
	publications.push(publication);
	return publication;
}

describe("local endpoint registry", () => {
	it("authenticates the existing version/token JSONL envelope and withdraws artifacts idempotently", async () => {
		const reg = registry();
		const pub = await publish(reg);
		const [entry] = await readLocalEndpointEntries(reg);
		expect(await queryLocalEndpoint(reg, entry!.meta, { op: "snapshot" }, 1500)).toEqual({
			status: "ok",
			value: { ok: true, v: 1, answer: "hello" },
		});
		expect(await queryLocalEndpoint(reg, { ...entry!.meta, token: "wrong" }, { op: "snapshot" }, 1500)).toEqual({
			status: "skip",
			error: "authentication_failed",
		});
		if (process.platform !== "win32") {
			expect((await fs.stat(reg.dir)).mode & 0o777).toBe(0o700);
			expect((await fs.stat(path.join(reg.dir, `${pub.entryId}.json`))).mode & 0o777).toBe(0o600);
			expect((await fs.stat(pub.endpoint)).mode & 0o777).toBe(0o600);
		}
		await Promise.all([pub.close(), pub.close()]);
		expect(await readLocalEndpointEntries(reg)).toEqual([]);
		if (process.platform !== "win32") expect(await Bun.file(pub.endpoint).exists()).toBe(false);
	});

	it("prunes an unreachable publication without removing its live successor", async () => {
		const reg = registry();
		const dead = await publish(reg);
		const file = path.join(reg.dir, `${dead.entryId}.json`);
		const metadata = await Bun.file(file).text();
		await dead.close();
		await fs.writeFile(file, metadata, { mode: 0o600 });
		const successor = await publish(reg);
		const live = await listLocalEndpoints(reg, entry =>
			queryLocalEndpoint(reg, entry.meta, { op: "snapshot" }, 1500),
		);
		expect(live.map(row => row.entry.entryId)).toEqual([successor.entryId]);
		expect(await Bun.file(file).exists()).toBe(false);
	});

	it("includes all versions only when requested and never prunes a live foreign-version owner", async () => {
		const reg = registry();
		const pub = await publish({ ...reg, version: 2 });
		const file = path.join(reg.dir, `${pub.entryId}.json`);
		const probe = vi.fn(async () => ({ status: "ok" as const, value: "live" }));

		expect(await listLocalEndpoints(reg, probe)).toEqual([]);
		expect(probe).not.toHaveBeenCalled();
		expect(await Bun.file(file).exists()).toBe(true);

		const live = await listLocalEndpoints(reg, probe, { includeAllVersions: true });
		expect(live.map(row => ({ entryId: row.entry.entryId, version: row.entry.meta.version }))).toEqual([
			{ entryId: pub.entryId, version: 2 },
		]);
		expect(probe).toHaveBeenCalledTimes(1);
		expect(await listLocalEndpoints(reg, async () => ({ status: "dead" }), { includeAllVersions: true })).toEqual([]);
		expect(await Bun.file(file).exists()).toBe(true);
	});

	it("preserves another OS's transport instead of probing or pruning it", async () => {
		const reg = registry();
		const id = "12345678";
		const metadata = path.join(reg.dir, `${id}.json`);
		await fs.writeFile(
			metadata,
			JSON.stringify({
				version: 1,
				instanceId: id,
				pid: process.pid,
				createdAt: Date.now(),
				endpoint: process.platform === "win32" ? "/tmp/foreign.sock" : "\\\\.\\pipe\\foreign",
			}),
			{ mode: 0o600 },
		);
		const probe = vi.fn(async () => ({ status: "dead" as const }));
		expect(await listLocalEndpoints(reg, probe)).toEqual([]);
		expect(probe).not.toHaveBeenCalled();
		expect(await Bun.file(metadata).exists()).toBe(true);
	});

	it("keeps hung endpoints when a query times out rather than treating them as dead", async () => {
		const reg = registry();
		const pub = await publishLocalEndpoint(reg, () => {});
		publications.push(pub);
		const queried = Promise.withResolvers<void>();
		vi.spyOn(net, "createConnection").mockImplementation(() => {
			queried.resolve();
			return new net.Socket();
		});
		vi.useFakeTimers();
		const live = listLocalEndpoints(reg, entry => queryLocalEndpoint(reg, entry.meta, {}, 10));
		await queried.promise;
		vi.advanceTimersByTime(10);
		expect(await live).toEqual([]);
		expect(await Bun.file(path.join(reg.dir, `${pub.entryId}.json`)).exists()).toBe(true);
	});

	it("bounds discovery probes to eight concurrent connections", async () => {
		const reg = registry();
		for (let n = 0; n < 12; n++) {
			const id = n.toString(16).padStart(8, "0");
			await fs.writeFile(
				path.join(reg.dir, `${id}.json`),
				JSON.stringify({
					version: 1,
					instanceId: id,
					pid: process.pid,
					endpoint: process.platform === "win32" ? `\\\\.\\pipe\\test-${id}` : path.join(reg.dir, `${id}.sock`),
					createdAt: 1,
				}),
				{ mode: 0o600 },
			);
		}
		let active = 0;
		let maximum = 0;
		const live = await listLocalEndpoints(reg, async entry => {
			maximum = Math.max(maximum, ++active);
			await Promise.resolve();
			active--;
			return { status: "ok", value: entry.entryId };
		});
		expect(live).toHaveLength(12);
		expect(maximum).toBe(8);
	});

	it("accepts 65 concurrent connections when no connection cap is requested", async () => {
		const reg = registry();
		const pub = await publishLocalEndpoint(reg, socket => socket.write("accepted\n"));
		publications.push(pub);
		const clients: net.Socket[] = [];
		try {
			const replies = await Promise.all(
				Array.from({ length: 65 }, () => {
					const accepted = Promise.withResolvers<string>();
					const socket = net.createConnection({ path: pub.endpoint });
					clients.push(socket);
					let reply = "";
					socket.setEncoding("utf8");
					socket.on("data", chunk => {
						reply += chunk;
						if (reply.includes("\n")) accepted.resolve(reply);
					});
					socket.once("error", accepted.reject);
					socket.once("close", () => accepted.reject(new Error("Connection closed before acceptance")));
					return accepted.promise;
				}),
			);
			expect(replies).toEqual(Array(65).fill("accepted\n"));
			expect(clients.every(socket => !socket.destroyed)).toBe(true);
		} finally {
			for (const socket of clients) socket.destroy();
		}
	});

	it.skipIf(process.platform === "win32")("refuses a symlink registry before it can publish or prune", async () => {
		const reg = registry();
		const link = `${reg.dir}-link`;
		await fs.symlink(reg.dir, link, "dir");
		try {
			const linked = { ...reg, dir: link };
			await expect(publishLocalEndpoint(linked, () => {})).rejects.toThrow("directory is a symlink");
			await expect(listLocalEndpoints(linked, async () => ({ status: "dead" }))).rejects.toThrow(
				"directory is a symlink",
			);
		} finally {
			await fs.unlink(link);
		}
	});

	it("closes lingering clients so unpublishing cannot hang", async () => {
		const reg = registry();
		const pub = await publishLocalEndpoint(reg, () => {});
		publications.push(pub);
		const socket = net.createConnection({ path: pub.endpoint });
		const connected = Promise.withResolvers<void>();
		socket.once("connect", () => connected.resolve());
		socket.once("error", connected.reject);
		await connected.promise;
		try {
			await pub.close();
			expect(await readLocalEndpointEntries(reg)).toEqual([]);
		} finally {
			socket.destroy();
		}
	});
});
