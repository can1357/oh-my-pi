import { afterEach, describe, expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { MAX_SERIALIZED_CHARS, MESSAGING_WIRE_VERSION } from "../../src/messaging/protocol";
import {
	assertPrivateDir,
	ensurePrivateDir,
	listLiveEntries,
	publishEntry,
	readEntries,
	type RegistryPublication,
} from "../../src/messaging/registry";

const publications: RegistryPublication[] = [];
const directories: TempDir[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const publication of publications.splice(0)) await publication.close();
	for (const dir of directories.splice(0)) dir[Symbol.dispose]();
});

async function registry(): Promise<string> {
	const dir = TempDir.createSync("@omp-messaging-registry-");
	directories.push(dir);
	await ensurePrivateDir(dir.path());
	return dir.path();
}

async function publish(dir: string, entryId = crypto.randomBytes(8).toString("hex")): Promise<RegistryPublication> {
	const publication = await publishEntry(dir, {
		entryId,
		sessionId: "registry-session",
		maxConnections: 64,
		maxFrameBytes: 3 * MAX_SERIALIZED_CHARS,
		onConnection: (connection, onClose) => connection.start(() => {}, onClose),
	});
	publications.push(publication);
	return publication;
}

async function writeMetadata(
	dir: string,
	entryId: string,
	endpoint: string,
	overrides: Record<string, unknown> = {},
): Promise<string> {
	const file = path.join(dir, `${entryId}.json`);
	await fs.writeFile(
		file,
		JSON.stringify({
			version: MESSAGING_WIRE_VERSION,
			instanceId: entryId,
			pid: process.pid,
			endpoint,
			createdAt: 1,
			entryId,
			sessionId: "registry-session",
			...overrides,
		}),
		{ mode: 0o600 },
	);
	return file;
}

describe("messaging registry", () => {
	it("prunes dead owner PIDs for both current and foreign wire versions without connecting", async () => {
		const dir = await registry();
		const files: string[] = [];
		for (const version of [MESSAGING_WIRE_VERSION, MESSAGING_WIRE_VERSION + 1]) {
			const publication = await publish(dir);
			files.push(await writeMetadata(dir, publication.entryId, publication.endpoint, { version, pid: 2147483647 }));
		}
		const kill = process.kill.bind(process);
		vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			if (pid === 2147483647) throw Object.assign(new Error("dead owner"), { code: "ESRCH" });
			return kill(pid, signal);
		});
		const connect = vi.spyOn(IpcConnection, "connect");
		expect(await listLiveEntries(dir, { timeoutMs: 1500 })).toEqual([]);
		expect(connect).not.toHaveBeenCalled();
		for (const file of files) expect(await Bun.file(file).exists()).toBe(false);
	});

	it("treats EPERM from a PID liveness probe as alive", async () => {
		const dir = await registry();
		const publication = await publish(dir);
		const kill = process.kill.bind(process);
		vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			if (pid === process.pid) throw Object.assign(new Error("permission denied"), { code: "EPERM" });
			return kill(pid, signal);
		});
		expect((await readEntries(dir)).map(entry => entry.entryId)).toEqual([publication.entryId]);
		expect((await listLiveEntries(dir, { timeoutMs: 1500 })).map(entry => entry.entryId)).toEqual([
			publication.entryId,
		]);
		expect(await Bun.file(path.join(dir, `${publication.entryId}.json`)).exists()).toBe(true);
	});

	it("never lists, connects to or prunes another OS's endpoint", async () => {
		const dir = await registry();
		const file = await writeMetadata(
			dir,
			"12345678",
			process.platform === "win32" ? "/tmp/foreign.sock" : "\\\\.\\pipe\\foreign",
			{ pid: 2147483647 },
		);
		const connect = vi.spyOn(IpcConnection, "connect");
		expect(await readEntries(dir)).toEqual([]);
		expect(await listLiveEntries(dir, { timeoutMs: 1500 })).toEqual([]);
		expect(connect).not.toHaveBeenCalled();
		expect(await Bun.file(file).exists()).toBe(true);
	});

	it("lists every wire version and preserves a live foreign-version owner even when its endpoint disappears", async () => {
		const dir = await registry();
		const publication = await publish(dir);
		const version = MESSAGING_WIRE_VERSION + 1;
		const file = await writeMetadata(dir, publication.entryId, publication.endpoint, { version });
		for (const entries of [await readEntries(dir), await listLiveEntries(dir, { timeoutMs: 1500 })]) {
			expect(entries.map(entry => ({ entryId: entry.entryId, version: entry.version }))).toEqual([
				{ entryId: publication.entryId, version },
			]);
		}
		const metadata = await Bun.file(file).text();
		await publication.close();
		await fs.writeFile(file, metadata, { mode: 0o600 });
		expect(await listLiveEntries(dir, { timeoutMs: 1500 })).toEqual([]);
		expect(await Bun.file(file).exists()).toBe(true);
	});

	it("prunes malformed rows only during live discovery, not metadata-only reads", async () => {
		const dir = await registry();
		const files = [path.join(dir, "12345678.json"), path.join(dir, "87654321.json")];
		await fs.writeFile(files[0]!, "{", { mode: 0o600 });
		await fs.writeFile(files[1]!, JSON.stringify({ instanceId: "87654321", pid: process.pid }), { mode: 0o600 });
		expect(await readEntries(dir)).toEqual([]);
		for (const file of files) expect(await Bun.file(file).exists()).toBe(true);
		expect(await listLiveEntries(dir, { timeoutMs: 1500 })).toEqual([]);
		for (const file of files) expect(await Bun.file(file).exists()).toBe(false);
	});

	it("prunes an unreachable predecessor without removing its live successor", async () => {
		const dir = await registry();
		const predecessor = await publish(dir);
		const file = path.join(dir, `${predecessor.entryId}.json`);
		const metadata = await Bun.file(file).text();
		await predecessor.close();
		await fs.writeFile(file, metadata, { mode: 0o600 });
		const successor = await publish(dir);
		expect((await listLiveEntries(dir, { timeoutMs: 1500 })).map(entry => entry.entryId)).toEqual([
			successor.entryId,
		]);
		expect(await Bun.file(file).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, `${successor.entryId}.json`)).exists()).toBe(true);
	});

	it("publishes complete metadata atomically with only the declared keys", async () => {
		const dir = await registry();
		const entryId = "12345678";
		const file = path.join(dir, `${entryId}.json`);
		const ready = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const rename = nodeFs.promises.rename;
		vi.spyOn(nodeFs.promises, "rename").mockImplementation(async (from, to) => {
			if (String(to) === file) {
				ready.resolve();
				await release.promise;
			}
			return rename(from, to);
		});
		const publishing = publish(dir, entryId);
		try {
			await Promise.race([
				ready.promise,
				publishing.then(() => {
					throw new Error("metadata rename was not intercepted");
				}),
			]);
			expect((await fs.readdir(dir)).filter(name => name.endsWith(".json"))).toEqual([]);
			expect(await readEntries(dir)).toEqual([]);
			expect(await Bun.file(`${file}.tmp`).json()).toMatchObject({
				instanceId: entryId,
				entryId,
				sessionId: "registry-session",
			});
		} finally {
			release.resolve();
			await publishing;
		}
		const publication = await publishing;
		const metadata = await Bun.file(file).json();
		expect(metadata).toEqual({
			version: MESSAGING_WIRE_VERSION,
			instanceId: entryId,
			pid: process.pid,
			endpoint: publication.endpoint,
			createdAt: expect.any(Number),
			entryId,
			sessionId: "registry-session",
		});
		expect(await Bun.file(`${file}.tmp`).exists()).toBe(false);
		if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
	});

	it("refuses a symlink registry before publishing or pruning", async () => {
		const dir = await registry();
		const link = `${dir}-link`;
		await fs.symlink(dir, link, process.platform === "win32" ? "junction" : "dir");
		try {
			await expect(publish(link)).rejects.toThrow(`messaging registry directory is a symlink: ${link}`);
			await expect(readEntries(link)).rejects.toThrow(`messaging registry directory is a symlink: ${link}`);
			await expect(listLiveEntries(link, { timeoutMs: 1500 })).rejects.toThrow(
				`messaging registry directory is a symlink: ${link}`,
			);
		} finally {
			await fs.unlink(link);
		}
	});

	it("refuses a registry path that is a regular file", async () => {
		const file = path.join(await registry(), "not-a-directory");
		await fs.writeFile(file, "", { mode: 0o600 });
		await expect(assertPrivateDir(file)).rejects.toThrow(`messaging registry path is not a directory: ${file}`);
	});

	it.skipIf(process.platform === "win32")("tightens a 0755 registry directory to 0700", async () => {
		const dir = await registry();
		await fs.chmod(dir, 0o755);
		await assertPrivateDir(dir);
		expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
	});

	it.skipIf(process.platform === "win32")("refuses a directory owned by a different uid", async () => {
		const dir = await registry();
		const uid = (await fs.stat(dir)).uid;
		vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
		await expect(assertPrivateDir(dir)).rejects.toThrow(
			`messaging registry directory is not owned by the current user: ${dir}`,
		);
	});

	it("withdraws metadata and POSIX endpoint files idempotently", async () => {
		const dir = await registry();
		const publication = await publish(dir);
		if (process.platform !== "win32") {
			expect((await fs.stat(publication.endpoint)).isSocket()).toBe(true);
			expect(await Bun.file(`${publication.endpoint}.bind.lock`).exists()).toBe(true);
		}
		await Promise.all([publication.close(), publication.close()]);
		await publication.close();
		expect(await readEntries(dir)).toEqual([]);
		expect(await Bun.file(path.join(dir, `${publication.entryId}.json`)).exists()).toBe(false);
		if (process.platform !== "win32") {
			await expect(fs.lstat(publication.endpoint)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await Bun.file(`${publication.endpoint}.bind.lock`).exists()).toBe(false);
		}
	});

	it("keeps metadata when a native connect times out rather than reporting the endpoint dead", async () => {
		const dir = await registry();
		const publication = await publish(dir);
		vi.spyOn(IpcConnection, "connect").mockRejectedValue(
			Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
		);
		expect(await listLiveEntries(dir, { timeoutMs: 10 })).toEqual([]);
		expect(await Bun.file(path.join(dir, `${publication.entryId}.json`)).exists()).toBe(true);
	});

	it("bounds discovery to eight concurrent native connects and preserves row-name order", async () => {
		const dir = await registry();
		const ids = Array.from({ length: 12 }, (_, n) => n.toString(16).padStart(8, "0"));
		for (const id of ids.toReversed()) await publish(dir, id);
		const connect = IpcConnection.connect.bind(IpcConnection);
		const firstWave = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let active = 0;
		let maximum = 0;
		vi.spyOn(IpcConnection, "connect").mockImplementation(async (endpoint, options) => {
			maximum = Math.max(maximum, ++active);
			if (active === 8) firstWave.resolve();
			try {
				await release.promise;
				return await connect(endpoint, options);
			} finally {
				active--;
			}
		});
		const listing = listLiveEntries(dir, { timeoutMs: 1500 });
		try {
			await Promise.race([
				firstWave.promise,
				listing.then(() => {
					throw new Error("discovery did not fill its first wave");
				}),
			]);
			expect(active).toBe(8);
		} finally {
			release.resolve();
		}
		expect((await listing).map(entry => entry.entryId)).toEqual(ids);
		expect(maximum).toBe(8);
	});

	it("returns no entries for a missing registry without creating it", async () => {
		const dir = path.join(await registry(), "missing");
		expect(await readEntries(dir)).toEqual([]);
		expect(await listLiveEntries(dir, { timeoutMs: 1500 })).toEqual([]);
		await expect(fs.lstat(dir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("skips a non-mailbox session identity without pruning its metadata", async () => {
		const dir = await registry();
		const publication = await publish(dir);
		const file = await writeMetadata(dir, publication.entryId, publication.endpoint, { sessionId: "../outside" });
		expect(await readEntries(dir)).toEqual([]);
		expect(await listLiveEntries(dir, { timeoutMs: 1500 })).toEqual([]);
		expect(await Bun.file(file).exists()).toBe(true);
	});
});
