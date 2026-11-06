import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { FileType, type GlobMatch } from "@oh-my-pi/pi-natives";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { glob, grep } from "../../src/ovnfs/search";

function frame(value: object): Buffer {
	const body = Buffer.from(JSON.stringify(value), "utf8");
	const header = Buffer.alloc(4);
	header.writeUInt32LE(body.length, 0);
	return Buffer.concat([header, body]);
}

// One fake daemon for the file, found through a fake ovnfs command: a process
// remembers each command's daemon.
describe("ovnfs search fast path", () => {
	let root: string;
	/** The fake daemon's mount, holding one checkout. */
	let mount: string;
	/** A checkout in the mount. */
	let dir: string;
	/** The fake ovnfs command. */
	let ovnfs: string;
	/** Arguments of each run of the fake command, one line per run. */
	let calls: string;
	let server: net.Server;
	/** Frames the daemon received after the handshake. */
	let received: Record<string, unknown>[];
	/** What the daemon answers each request with; undefined holds the request. */
	let reply: Record<string, unknown> | undefined;
	let gotFrame: () => void;
	/** The client keeps its connection open; teardown closes it from this side. */
	const conns = new Set<net.Socket>();

	beforeAll(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-ovnfs-search-")));
		mount = path.join(root, "checkouts");
		dir = path.join(mount, "app");
		calls = path.join(root, "calls");
		const socket = path.join(root, "admin.sock");
		server = net.createServer(conn => {
			conns.add(conn);
			let buffered = Buffer.alloc(0);
			conn.on("data", (chunk: Buffer) => {
				buffered = Buffer.concat([buffered, chunk]);
				while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32LE(0)) {
					const length = buffered.readUInt32LE(0);
					const message = JSON.parse(buffered.subarray(4, 4 + length).toString("utf8"));
					buffered = buffered.subarray(4 + length);
					if (message.hello) {
						conn.write(frame({ welcome: { version: 5, ops: ["grep", "glob"] } }));
						continue;
					}
					received.push(message);
					gotFrame();
					if (reply && "id" in message) conn.write(frame({ id: message.id, ...reply }));
				}
			});
		});
		const listening = Promise.withResolvers<void>();
		server.listen(socket, listening.resolve);
		await listening.promise;
		await Bun.write(path.join(dir, "a.txt"), "needle here\n");
		await Bun.write(path.join(dir, "sub", "b.txt"), "needle there\n");
		await Bun.write(path.join(root, "host", "c.txt"), "needle elsewhere\n");
		ovnfs = path.join(root, "ovnfs");
		const status = JSON.stringify({ version: 5, pid: 1, socket, mount });
		await Bun.write(ovnfs, `#!/bin/sh\necho "$@" >> '${calls}'\necho '${status}'\n`);
		await fs.chmod(ovnfs, 0o755);
	});

	beforeEach(() => {
		received = [];
		reply = undefined;
		gotFrame = () => {};
	});

	afterAll(async () => {
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		for (const conn of conns) conn.destroy();
		await closed.promise;
		await removeWithRetries(root);
	});

	it("maps grep options and the daemon reply", async () => {
		const file = path.join(dir, "a.txt");
		reply = {
			ok: {
				matches: [{ path: "/virtual/a.txt", line: 1, text: "needle", truncated: true, count: 0, column: 3 }],
				total_matches: 1,
				files_with_matches: 1,
				files_searched: 1,
				limit_reached: false,
			},
		};
		const result = await grep({ pattern: "needle", path: file, recursive: false, exclude: [] }, null, ovnfs);
		expect(received).toEqual([
			{
				id: expect.any(Number),
				grep: { dir: await fs.realpath(file), pattern: "needle", anchored: true, hidden: true },
			},
		]);
		expect(result.matches).toEqual([{ path: file, lineNumber: 1, line: "needle", truncated: true, column: 3 }]);
		expect(result.totalMatches).toBe(1);
		expect(result.filesSearched).toBe(1);
	});

	it("maps glob replies and calls onMatch per match", async () => {
		reply = {
			ok: {
				matches: [
					{ path: "a.txt", type: "file", size: 12, mtime: 1_700_000_000_123_456_000 },
					{ path: "sub", type: "dir", size: -1, mtime: 0 },
				],
				total: 2,
				truncated: false,
			},
		};
		const seen: GlobMatch[] = [];
		const result = await glob({ pattern: "*", path: dir }, (_err, match) => seen.push(match), ovnfs);
		expect(received).toEqual([{ id: expect.any(Number), glob: { dir: await fs.realpath(dir), pattern: "*" } }]);
		const expected = [
			{ path: "a.txt", fileType: FileType.File, size: 12, mtime: Math.floor(1_700_000_000_123_456_000 / 1e6) },
			{ path: "sub", fileType: FileType.Dir },
		];
		expect(result).toEqual({ matches: expected, totalMatches: 2 });
		expect(seen).toEqual(expected);
	});

	it("sends only paths in a checkout to the daemon, asking the command once", async () => {
		reply = { ok: { matches: [], total: 0, truncated: false } };
		await glob({ pattern: "*", path: path.join(dir, "sub") }, null, ovnfs);
		const host = await glob({ pattern: "*", path: path.join(root, "host") }, null, ovnfs);
		// The mount folder lists checkouts; the daemon searches inside one.
		await glob({ pattern: "*", path: mount }, null, ovnfs);
		expect(received.map(m => m.glob)).toEqual([{ dir: path.join(dir, "sub"), pattern: "*" }]);
		expect(host.matches.map(m => m.path)).toEqual(["c.txt"]);
		expect((await fs.readFile(calls, "utf8")).trim().split("\n")).toEqual(["--json status"]);
	});

	it("searches natively without an ovnfs command", async () => {
		const result = await grep({ pattern: "needle", path: dir });
		expect(received).toEqual([]);
		expect(result.matches.map(m => m.path).sort()).toEqual(["a.txt", "sub/b.txt"]);
	});

	it("cancels the daemon's search when the caller aborts", async () => {
		const controller = new AbortController();
		const sent = Promise.withResolvers<void>();
		gotFrame = sent.resolve;
		const search = grep({ pattern: "needle", path: dir, signal: controller.signal }, null, ovnfs);
		await sent.promise;
		const cancelled = Promise.withResolvers<void>();
		gotFrame = cancelled.resolve;
		controller.abort();
		await expect(search).rejects.toMatchObject({ name: "AbortError", message: "Aborted: Signal" });
		await cancelled.promise;
		expect(received).toEqual([{ id: expect.any(Number), grep: expect.any(Object) }, { cancel: received[0]?.id }]);
	});

	it("falls back to native grep when the daemon reports an error", async () => {
		reply = { error: { code: "invalid", message: "unknown field" } };
		const result = await grep({ pattern: "needle", path: dir }, null, ovnfs);
		expect(received).toHaveLength(1);
		expect(result.matches.map(m => m.path).sort()).toEqual(["a.txt", "sub/b.txt"]);
	});
});
