import { afterEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
	COLLAB_REGISTRY_VERSION,
	type CollabHostPublication,
	type CollabHostSnapshotProvider,
	listCollabHosts,
	publishCollabHost,
} from "@oh-my-pi/pi-coding-agent/collab/registry";

const cleanupDirs: string[] = [];
const openPublications: CollabHostPublication[] = [];
const openServers: { server: net.Server; sockets: Set<net.Socket> }[] = [];

afterEach(async () => {
	for (const pub of openPublications.splice(0)) {
		try {
			await pub.close();
		} catch {
			// best-effort
		}
	}
	for (const { server, sockets } of openServers.splice(0)) {
		// server.close() waits for every accepted connection to end; a deliberately
		// hung fixture socket would otherwise stall the hook past its timeout.
		for (const socket of sockets) socket.destroy();
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		await closed.promise;
	}
	for (const dir of cleanupDirs.splice(0)) {
		await fsp.rm(dir, { recursive: true, force: true });
	}
});

async function tempDir(prefix = "omp-collab-registry-"): Promise<string> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanupDirs.push(dir);
	return dir;
}

interface Fixture {
	sessionId: string;
	sessionName: string | null;
	cwd: string;
	pid: number;
	startedAt: number;
	participants: number;
	roomKey: string;
	writeToken: string;
	writeUrl: string;
	viewUrl: string;
}

function makeFixture(over: Partial<Fixture> = {}): Fixture {
	const roomKey = over.roomKey ?? `ROOMKEY-${crypto.randomBytes(6).toString("hex")}`;
	const writeToken = over.writeToken ?? `WRITETOKEN-${crypto.randomBytes(6).toString("hex")}`;
	return {
		sessionId: over.sessionId ?? `sess-${crypto.randomBytes(4).toString("hex")}`,
		sessionName: over.sessionName ?? "Fixture Session",
		cwd: over.cwd ?? "/tmp/fixture-cwd",
		pid: over.pid ?? 4242,
		startedAt: over.startedAt ?? 1_700_000_000_000,
		participants: over.participants ?? 3,
		roomKey,
		writeToken,
		writeUrl: over.writeUrl ?? `https://collab.example/#room=${roomKey}&k=${writeToken}`,
		viewUrl: over.viewUrl ?? `https://collab.example/#room=${roomKey}&view=1`,
	};
}

function providerFor(f: Fixture): CollabHostSnapshotProvider {
	return mode => ({
		sessionId: f.sessionId,
		sessionName: f.sessionName,
		cwd: f.cwd,
		pid: f.pid,
		startedAt: f.startedAt,
		participants: f.participants,
		url: mode === "write" ? f.writeUrl : f.viewUrl,
	});
}

async function publish(dir: string, f: Fixture): Promise<CollabHostPublication> {
	const pub = await publishCollabHost(providerFor(f), { dir });
	openPublications.push(pub);
	return pub;
}

/** Reads the discovery token from the single metadata file in `dir`. */
async function readSoleToken(dir: string): Promise<string> {
	const names = (await fsp.readdir(dir)).filter(n => n.endsWith(".json"));
	expect(names.length).toBe(1);
	const meta = JSON.parse(await fsp.readFile(path.join(dir, names[0]!), "utf8"));
	return meta.token as string;
}

/** Connects to `endpoint`, sends one JSON request line, returns the raw response line. */
function rawRequest(endpoint: string, request: object): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	let buffer = "";
	const socket = net.createConnection({ path: endpoint });
	const done = (fn: () => void): void => {
		socket.destroy();
		fn();
	};
	socket.setEncoding("utf8");
	socket.once("error", err => done(() => reject(err)));
	socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
	socket.on("data", chunk => {
		buffer += chunk;
		const nl = buffer.indexOf("\n");
		// Endpoints answer with one line synchronously; no wall-clock guard needed.
		if (nl >= 0) done(() => resolve(buffer.slice(0, nl)));
	});
	return promise;
}

function auxEndpoint(dir: string, label: string): string {
	const id = crypto.randomBytes(4).toString("hex");
	return process.platform === "win32"
		? `\\\\.\\pipe\\omp-collab-test-${label}-${id}`
		: path.join(dir, `${label}-${id}.sock`);
}

function writeMetadata(dir: string, name: string, meta: Record<string, unknown>): void {
	fs.writeFileSync(path.join(dir, name), JSON.stringify(meta), { mode: 0o600 });
}

function freshDeadPid(): number {
	// The child has already exited by the time spawnSync returns: a real, dead PID.
	return Bun.spawnSync(["bun", "-e", ""]).pid;
}

function collectRegularFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...collectRegularFiles(full));
		else if (entry.isFile()) out.push(full);
	}
	return out;
}

describe("collab registry", () => {
	it("round-trips a published host through list for both access modes", async () => {
		const dir = await tempDir();
		const f = makeFixture({ sessionName: "Round Trip", cwd: "/work/project", pid: 1234, participants: 5 });
		await publish(dir, f);

		const write = await listCollabHosts({ dir });
		expect(write.length).toBe(1);
		const host = write[0]!;
		expect(host.mode).toBe("write");
		expect(host.url).toBe(f.writeUrl);
		expect(host.sessionId).toBe(f.sessionId);
		expect(host.sessionName).toBe("Round Trip");
		expect(host.cwd).toBe("/work/project");
		expect(host.pid).toBe(1234);
		expect(host.startedAt).toBe(f.startedAt);
		expect(host.participants).toBe(5);

		const view = await listCollabHosts({ dir, mode: "view" });
		expect(view.length).toBe(1);
		expect(view[0]!.sessionId).toBe(f.sessionId);
		expect(view[0]!.mode).toBe("view");
		expect(view[0]!.url).toBe(f.viewUrl);
		expect(view[0]!.url).not.toContain(f.writeToken);
	});

	it("never transmits the write URL to a view request on the wire", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		const pub = await publish(dir, f);
		const token = await readSoleToken(dir);

		const line = await rawRequest(pub.endpoint, { v: COLLAB_REGISTRY_VERSION, token, mode: "view" });
		expect(line).toContain(f.viewUrl);
		expect(line).not.toContain(f.writeUrl);
		expect(line).not.toContain(f.writeToken);
		const parsed = JSON.parse(line);
		expect(parsed.ok).toBe(true);
		expect(parsed.host.mode).toBe("view");
		expect(parsed.host.url).toBe(f.viewUrl);
	});

	it("keeps URLs and secrets off disk while published", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		await publish(dir, f);
		// Exercise both modes so any URL caching would surface on disk.
		await listCollabHosts({ dir });
		await listCollabHosts({ dir, mode: "view" });

		const files = collectRegularFiles(dir);
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			const content = fs.readFileSync(file, "utf8");
			expect(content).not.toContain(f.writeUrl);
			expect(content).not.toContain(f.viewUrl);
			expect(content).not.toContain(f.roomKey);
			expect(content).not.toContain(f.writeToken);
		}
	});

	it("rejects a wrong token without leaking a host or URL", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		const pub = await publish(dir, f);

		const line = await rawRequest(pub.endpoint, {
			v: COLLAB_REGISTRY_VERSION,
			token: "not-the-real-token",
			mode: "write",
		});
		const parsed = JSON.parse(line);
		expect(parsed.ok).toBe(false);
		expect(parsed.host).toBeUndefined();
		expect(line).not.toContain(f.writeUrl);
		expect(line).not.toContain(f.viewUrl);
		expect(line).not.toContain(f.roomKey);
	});

	it("sorts hosts by startedAt then pid regardless of publish order", async () => {
		const dir = await tempDir();
		const early = makeFixture({ sessionId: "early", startedAt: 900, pid: 99 });
		const tieHigh = makeFixture({ sessionId: "tie-high", startedAt: 1000, pid: 50 });
		const tieLow = makeFixture({ sessionId: "tie-low", startedAt: 1000, pid: 30 });

		// Publish out of expected order.
		await publish(dir, tieHigh);
		await publish(dir, early);
		await publish(dir, tieLow);

		const hosts = await listCollabHosts({ dir });
		expect(hosts.map(h => h.sessionId)).toEqual(["early", "tie-low", "tie-high"]);
	});

	it("returns only the healthy host and prunes stale entries on partial failure", async () => {
		const dir = await tempDir();
		const healthy = makeFixture({ sessionId: "healthy" });
		await publish(dir, healthy);

		// (b) malformed JSON.
		fs.writeFileSync(path.join(dir, "garbage.json"), "{not json", { mode: 0o600 });

		// (c) version mismatch with a dead PID -> pruned.
		writeMetadata(dir, "version-mismatch.json", {
			version: 99,
			pid: freshDeadPid(),
			endpoint: auxEndpoint(dir, "vmismatch"),
			createdAt: Date.now(),
			token: crypto.randomBytes(16).toString("hex"),
		});

		// (d) stale: nonexistent socket + dead PID -> connection error -> pruned.
		writeMetadata(dir, "stale.json", {
			version: COLLAB_REGISTRY_VERSION,
			pid: freshDeadPid(),
			endpoint: auxEndpoint(dir, "stale-missing"),
			createdAt: Date.now(),
			token: crypto.randomBytes(16).toString("hex"),
		});

		// (e) unresponsive: accepts connections, never answers -> skipped, not pruned.
		const unresponsiveEndpoint = auxEndpoint(dir, "unresponsive");
		const hungSockets = new Set<net.Socket>();
		const unresponsive = net.createServer(socket => {
			// Accept and hang; afterEach severs these before closing the server.
			// A client-side destroy may surface as ECONNRESET here — swallow it
			// so an unhandled 'error' cannot take the test process down.
			hungSockets.add(socket);
			socket.on("error", () => {});
			socket.once("close", () => hungSockets.delete(socket));
		});
		openServers.push({ server: unresponsive, sockets: hungSockets });
		const listening = Promise.withResolvers<void>();
		unresponsive.once("error", err => listening.reject(err));
		unresponsive.listen(unresponsiveEndpoint, () => listening.resolve());
		await listening.promise;
		writeMetadata(dir, "unresponsive.json", {
			version: COLLAB_REGISTRY_VERSION,
			pid: process.pid,
			endpoint: unresponsiveEndpoint,
			createdAt: Date.now(),
			token: crypto.randomBytes(16).toString("hex"),
		});

		const hosts = await listCollabHosts({ dir, timeoutMs: 250 });
		expect(hosts.map(h => h.sessionId)).toEqual(["healthy"]);

		expect(fs.existsSync(path.join(dir, "garbage.json"))).toBe(false);
		expect(fs.existsSync(path.join(dir, "version-mismatch.json"))).toBe(false);
		expect(fs.existsSync(path.join(dir, "stale.json"))).toBe(false);
		// No prune on timeout: the unresponsive entry survives.
		expect(fs.existsSync(path.join(dir, "unresponsive.json"))).toBe(true);
	});

	it("removes on-disk state and disappears from listings after close", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		const pub = await publish(dir, f);
		expect((await listCollabHosts({ dir })).length).toBe(1);

		await pub.close();

		expect(await listCollabHosts({ dir })).toEqual([]);
		const remainingJson = (await fsp.readdir(dir)).filter(n => n.endsWith(".json"));
		expect(remainingJson).toEqual([]);
		if (process.platform !== "win32") {
			expect(fs.existsSync(pub.endpoint)).toBe(false);
		}
	});

	it("treats endpoint death as authoritative over a reused PID", async () => {
		const dir = await tempDir();
		// Alive PID (simulating PID reuse) but nothing listens on the endpoint.
		const forgedFile = "reused-pid.json";
		writeMetadata(dir, forgedFile, {
			version: COLLAB_REGISTRY_VERSION,
			pid: process.pid,
			endpoint: auxEndpoint(dir, "reused"),
			createdAt: Date.now(),
			token: crypto.randomBytes(16).toString("hex"),
		});

		expect(await listCollabHosts({ dir })).toEqual([]);
		expect(fs.existsSync(path.join(dir, forgedFile))).toBe(false);
	});

	it("hides a forged entry pointing at a real endpoint with a wrong token", async () => {
		const dir = await tempDir();
		const f = makeFixture({ sessionId: "genuine" });
		const pub = await publish(dir, f);

		// Second metadata entry aims at B's real endpoint but with a different token.
		writeMetadata(dir, "forged.json", {
			version: COLLAB_REGISTRY_VERSION,
			pid: process.pid,
			endpoint: pub.endpoint,
			createdAt: Date.now(),
			token: crypto.randomBytes(16).toString("hex"),
		});

		const hosts = await listCollabHosts({ dir });
		expect(hosts.length).toBe(1);
		expect(hosts[0]!.sessionId).toBe("genuine");
		expect(hosts[0]!.url).toBe(f.writeUrl);
	});

	it("creates owner-only permissions on unix", async () => {
		if (process.platform === "win32") return;
		const dir = await tempDir();
		const f = makeFixture();
		const pub = await publish(dir, f);

		expect(fs.statSync(dir).mode & 0o777).toBe(0o700);

		const jsonNames = (await fsp.readdir(dir)).filter(n => n.endsWith(".json"));
		expect(jsonNames.length).toBe(1);
		expect(fs.statSync(path.join(dir, jsonNames[0]!)).mode & 0o777).toBe(0o600);

		expect(fs.statSync(pub.endpoint).mode & 0o777).toBe(0o600);
	});
});
