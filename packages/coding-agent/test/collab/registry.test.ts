import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
	COLLAB_REGISTRY_VERSION,
	type CollabHostPublication,
	type CollabHostRegistrySource,
	type CollabHostSnapshot,
	listCollabHosts,
	publishCollabHost,
	resolveCollabHostLink,
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
		// Hung fixture sockets must not keep server.close() waiting forever.
		for (const socket of sockets) socket.destroy();
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		await closed.promise;
	}
	for (const dir of cleanupDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-registry-"));
	cleanupDirs.push(dir);
	return dir;
}

interface Fixture {
	snapshot: CollabHostSnapshot;
	roomKey: string;
	writeToken: string;
	controlUrl: string;
	viewUrl: string;
}

function makeFixture(over: Partial<CollabHostSnapshot> = {}): Fixture {
	const roomKey = `ROOMKEY-${crypto.randomBytes(6).toString("hex")}`;
	const writeToken = `WRITETOKEN-${crypto.randomBytes(6).toString("hex")}`;
	return {
		snapshot: {
			instanceId: crypto.randomBytes(8).toString("hex"),
			generation: 1,
			sessionId: `sess-${crypto.randomBytes(4).toString("hex")}`,
			sessionName: "Fixture Session",
			cwd: "/tmp/fixture-cwd",
			pid: process.pid,
			model: { provider: "test", id: "fixture-model" },
			startedAt: 1_700_000_000_000,
			participants: 3,
			relayConnected: true,
			inputRequired: false,
			access: "control",
			...over,
		},
		roomKey,
		writeToken,
		controlUrl: `https://collab.example/control/#room=${roomKey}&k=${writeToken}`,
		viewUrl: `https://collab.example/view/#room=${roomKey}`,
	};
}

function sourceFor(f: Fixture): CollabHostRegistrySource {
	return {
		snapshot: () => f.snapshot,
		link: access => (access === "view" ? f.viewUrl : f.snapshot.access === "control" ? f.controlUrl : null),
	};
}

async function publish(dir: string, f: Fixture): Promise<CollabHostPublication> {
	const pub = await publishCollabHost(sourceFor(f), { dir, instanceId: f.snapshot.instanceId });
	openPublications.push(pub);
	return pub;
}

/** Reads the discovery token from the single metadata file in `dir`. */
async function readSoleToken(dir: string): Promise<string> {
	const names = (await fs.readdir(dir)).filter(n => n.endsWith(".json"));
	expect(names).toHaveLength(1);
	const [name] = names;
	if (!name) throw new Error("published registry metadata is missing");
	const meta = await Bun.file(path.join(dir, name)).json();
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

async function writeMetadata(dir: string, name: string, meta: Record<string, unknown>): Promise<void> {
	await Bun.write(
		path.join(dir, name),
		JSON.stringify({ instanceId: crypto.randomBytes(8).toString("hex"), ...meta }),
	);
}

function freshDeadPid(): number {
	// The child has exited by the time spawnSync returns: a real, dead PID.
	return Bun.spawnSync([process.execPath, "-e", ""]).pid;
}

async function collectRegularFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await collectRegularFiles(full)));
		else if (entry.isFile()) out.push(full);
	}
	return out;
}

describe("collab registry", () => {
	it("lists metadata without capabilities and resolves only the requested access by instance ID", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		await publish(dir, f);

		const hosts = await listCollabHosts({ dir });
		expect(hosts.map(host => host.instanceId)).toEqual([f.snapshot.instanceId]);
		expect(hosts[0]).not.toHaveProperty("url");
		expect(JSON.stringify(hosts)).not.toContain(f.roomKey);
		expect(JSON.stringify(hosts)).not.toContain(f.writeToken);

		expect(await resolveCollabHostLink(f.snapshot.instanceId, "control", { dir })).toEqual({
			instanceId: f.snapshot.instanceId,
			generation: f.snapshot.generation,
			access: "control",
			url: f.controlUrl,
		});
		const view = await resolveCollabHostLink(f.snapshot.instanceId, "view", { dir });
		expect(view).toEqual({
			instanceId: f.snapshot.instanceId,
			generation: f.snapshot.generation,
			access: "view",
			url: f.viewUrl,
		});
		expect(JSON.stringify(view)).not.toContain(f.controlUrl);
		expect(JSON.stringify(view)).not.toContain(f.writeToken);
	});

	it("returns only the requested URL on the link wire, never the control capability to a view request", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		const pub = await publish(dir, f);
		const request = { v: COLLAB_REGISTRY_VERSION, token: await readSoleToken(dir), op: "link", generation: 1 };

		const control = await rawRequest(pub.endpoint, { ...request, access: "control" });
		expect(JSON.parse(control)).toEqual({ ok: true, v: COLLAB_REGISTRY_VERSION, url: f.controlUrl });
		const view = await rawRequest(pub.endpoint, { ...request, access: "view" });
		expect(JSON.parse(view)).toEqual({ ok: true, v: COLLAB_REGISTRY_VERSION, url: f.viewUrl });
		expect(view).not.toContain(f.controlUrl);
		expect(view).not.toContain(f.writeToken);
	});

	it("refuses control access to a view-only host through resolution and the wire", async () => {
		const dir = await tempDir();
		const f = makeFixture({ access: "view" });
		const pub = await publish(dir, f);

		await expect(resolveCollabHostLink(f.snapshot.instanceId, "control", { dir })).rejects.toMatchObject({
			name: "CollabLinkError",
			code: "access_unavailable",
		});
		const line = await rawRequest(pub.endpoint, {
			v: COLLAB_REGISTRY_VERSION,
			token: await readSoleToken(dir),
			op: "link",
			access: "control",
			generation: f.snapshot.generation,
		});
		expect(JSON.parse(line)).toEqual({ ok: false, v: COLLAB_REGISTRY_VERSION, error: "access_unavailable" });
		expect(await resolveCollabHostLink(f.snapshot.instanceId, "view", { dir })).toMatchObject({
			access: "view",
			url: f.viewUrl,
		});
	});

	it("rejects a listed generation after the room rotates without returning its successor's URL", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		const pub = await publish(dir, f);
		const [listed] = await listCollabHosts({ dir });
		if (!listed) throw new Error("published host was not discoverable");
		f.snapshot.generation++;

		const line = await rawRequest(pub.endpoint, {
			v: COLLAB_REGISTRY_VERSION,
			token: await readSoleToken(dir),
			op: "link",
			access: "control",
			generation: listed.generation,
		});
		expect(JSON.parse(line)).toEqual({ ok: false, v: COLLAB_REGISTRY_VERSION, error: "stale_generation" });
	});

	it("surfaces stale_generation when the host rotates between resolution's snapshot and link requests", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		const source = sourceFor(f);
		let rotate = false;
		source.snapshot = () => {
			const snapshot = { ...f.snapshot };
			if (rotate) {
				f.snapshot.generation++;
				rotate = false;
			}
			return snapshot;
		};
		openPublications.push(await publishCollabHost(source, { dir, instanceId: f.snapshot.instanceId }));
		await listCollabHosts({ dir });
		rotate = true;

		await expect(resolveCollabHostLink(f.snapshot.instanceId, "control", { dir })).rejects.toMatchObject({
			name: "CollabLinkError",
			code: "stale_generation",
		});
	});

	it("resolves a unique PID and rejects it as ambiguous when a second instance shares the process", async () => {
		const dir = await tempDir();
		const first = makeFixture({ instanceId: "pid-first" });
		await publish(dir, first);
		expect(await resolveCollabHostLink(String(process.pid), "control", { dir })).toMatchObject({
			instanceId: first.snapshot.instanceId,
			url: first.controlUrl,
		});

		await publish(dir, makeFixture({ instanceId: "pid-second" }));
		await expect(resolveCollabHostLink(String(process.pid), "control", { dir })).rejects.toMatchObject({
			name: "CollabLinkError",
			code: "ambiguous",
		});
	});

	it("prefers an exact numeric instance ID over a matching PID", async () => {
		const dir = await tempDir();
		const exact = makeFixture({ instanceId: "99999999" });
		await publish(dir, exact);
		await publish(dir, makeFixture({ instanceId: "numeric-pid", pid: 99_999_999 }));

		expect(await resolveCollabHostLink("99999999", "control", { dir })).toMatchObject({
			instanceId: exact.snapshot.instanceId,
			url: exact.controlUrl,
		});
	});

	it("reports not_found for an unknown selector", async () => {
		const dir = await tempDir();
		await publish(dir, makeFixture());
		await expect(resolveCollabHostLink("missing-host", "control", { dir })).rejects.toMatchObject({
			name: "CollabLinkError",
			code: "not_found",
		});
	});

	it("rejects invalid access and missing or unknown operations without returning capabilities", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		const pub = await publish(dir, f);
		const auth = { v: COLLAB_REGISTRY_VERSION, token: await readSoleToken(dir) };

		const invalidAccess = await rawRequest(pub.endpoint, { ...auth, op: "link", access: "write", generation: 1 });
		expect(JSON.parse(invalidAccess)).toEqual({ ok: false, v: COLLAB_REGISTRY_VERSION, error: "invalid_access" });
		const missingOp = await rawRequest(pub.endpoint, auth);
		expect(JSON.parse(missingOp)).toEqual({ ok: false, v: COLLAB_REGISTRY_VERSION, error: "invalid_operation" });
		const unknownOp = await rawRequest(pub.endpoint, { ...auth, op: "unknown" });
		expect(JSON.parse(unknownOp)).toEqual({ ok: false, v: COLLAB_REGISTRY_VERSION, error: "invalid_operation" });
	});

	it("keeps both URLs and room secrets off disk even after resolving links", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		await publish(dir, f);
		await listCollabHosts({ dir });
		await resolveCollabHostLink(f.snapshot.instanceId, "control", { dir });
		await resolveCollabHostLink(f.snapshot.instanceId, "view", { dir });

		const files = await collectRegularFiles(dir);
		expect(files).toContain(path.join(dir, `${f.snapshot.instanceId}.json`));
		for (const file of files) {
			const content = await Bun.file(file).text();
			expect(content).not.toContain(f.controlUrl);
			expect(content).not.toContain(f.viewUrl);
			expect(content).not.toContain(f.roomKey);
			expect(content).not.toContain(f.writeToken);
		}
	});

	it("rejects a wrong bearer without leaking metadata or capabilities", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		const pub = await publish(dir, f);
		const auth = { v: COLLAB_REGISTRY_VERSION, token: "not-the-real-token" };

		const snapshot = await rawRequest(pub.endpoint, { ...auth, op: "snapshot" });
		expect(JSON.parse(snapshot)).toEqual({ ok: false, v: COLLAB_REGISTRY_VERSION, error: "authentication_failed" });
		const link = await rawRequest(pub.endpoint, { ...auth, op: "link", access: "control", generation: 1 });
		expect(JSON.parse(link)).toEqual({ ok: false, v: COLLAB_REGISTRY_VERSION, error: "authentication_failed" });
	});

	it("sorts hosts by startedAt, pid, then instanceId regardless of publication order", async () => {
		const dir = await tempDir();
		const early = makeFixture({ instanceId: "early-host", startedAt: 900, pid: 99 });
		const highPid = makeFixture({ instanceId: "high-pid", startedAt: 1000, pid: 50 });
		const lowId = makeFixture({ instanceId: "tie-alpha", startedAt: 1000, pid: 30 });
		const highId = makeFixture({ instanceId: "tie-bravo", startedAt: 1000, pid: 30 });
		await publish(dir, highPid);
		await publish(dir, highId);
		await publish(dir, early);
		await publish(dir, lowId);

		const hosts = await listCollabHosts({ dir });
		expect(hosts.map(h => h.instanceId)).toEqual(["early-host", "tie-alpha", "tie-bravo", "high-pid"]);
	});

	it("lists healthy hosts, prunes malformed or dead entries, and preserves live incompatible or timed-out entries", async () => {
		const dir = await tempDir();
		await publish(dir, makeFixture({ sessionId: "healthy" }));
		await Bun.write(path.join(dir, "garbage.json"), "{not json");
		await writeMetadata(dir, "version-mismatch.json", {
			version: 99,
			pid: freshDeadPid(),
			endpoint: auxEndpoint(dir, "vmismatch"),
			createdAt: Date.now(),
			token: crypto.randomBytes(16).toString("hex"),
		});
		await writeMetadata(dir, "live-version-mismatch.json", {
			version: 99,
			pid: process.pid,
			endpoint: auxEndpoint(dir, "live-version"),
			createdAt: Date.now(),
			token: crypto.randomBytes(16).toString("hex"),
		});
		await writeMetadata(dir, "stale.json", {
			version: COLLAB_REGISTRY_VERSION,
			pid: freshDeadPid(),
			endpoint: auxEndpoint(dir, "stale-missing"),
			createdAt: Date.now(),
			token: crypto.randomBytes(16).toString("hex"),
		});

		const unresponsiveEndpoint = auxEndpoint(dir, "unresponsive");
		const hungSockets = new Set<net.Socket>();
		const unresponsive = net.createServer(socket => {
			hungSockets.add(socket);
			socket.on("error", () => {});
			socket.once("close", () => hungSockets.delete(socket));
		});
		openServers.push({ server: unresponsive, sockets: hungSockets });
		const listening = Promise.withResolvers<void>();
		unresponsive.once("error", err => listening.reject(err));
		unresponsive.listen(unresponsiveEndpoint, () => listening.resolve());
		await listening.promise;
		await writeMetadata(dir, "unresponsive.json", {
			version: COLLAB_REGISTRY_VERSION,
			pid: process.pid,
			endpoint: unresponsiveEndpoint,
			createdAt: Date.now(),
			token: crypto.randomBytes(16).toString("hex"),
		});

		const hosts = await listCollabHosts({ dir, timeoutMs: 250 });
		expect(hosts.map(h => h.sessionId)).toEqual(["healthy"]);
		const remaining = await fs.readdir(dir);
		expect(remaining).not.toContain("garbage.json");
		expect(remaining).not.toContain("version-mismatch.json");
		expect(remaining).not.toContain("stale.json");
		expect(remaining).toContain("live-version-mismatch.json");
		expect(remaining).toContain("unresponsive.json");
	});

	it("skips a transient connection error without pruning a host that becomes reachable again", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		await publish(dir, f);
		const connect = spyOn(net, "createConnection").mockImplementation(() => {
			const socket = new net.Socket();
			queueMicrotask(() => socket.emit("error", Object.assign(new Error("file limit"), { code: "EMFILE" })));
			return socket;
		});
		try {
			expect(await listCollabHosts({ dir })).toEqual([]);
		} finally {
			connect.mockRestore();
		}

		expect(await resolveCollabHostLink(f.snapshot.instanceId, "control", { dir })).toMatchObject({
			url: f.controlUrl,
		});
	});

	it("does not prune a successor room that republished under the same instance while the query failed", async () => {
		const dir = await tempDir();
		// Stale metadata for generation N whose endpoint is already gone.
		await writeMetadata(dir, "rotating-host.json", {
			version: COLLAB_REGISTRY_VERSION,
			instanceId: "rotating-host",
			pid: process.pid,
			endpoint: path.join(dir, "rotating-host.sock"),
			createdAt: Date.now(),
			token: "stale-token",
		});
		// The listing reads N's metadata, then its connect fails with ENOENT —
		// and in that gap generation N+1 publishes under the same instance name.
		const successor = makeFixture({ instanceId: "rotating-host", sessionId: "generation-2" });
		let republished: Promise<CollabHostPublication> | undefined;
		const connect = spyOn(net, "createConnection").mockImplementation(() => {
			const socket = new net.Socket();
			republished ??= publish(dir, successor);
			void republished.then(() =>
				socket.emit("error", Object.assign(new Error("no such socket"), { code: "ENOENT" })),
			);
			return socket;
		});
		let hosts: CollabHostSnapshot[];
		try {
			hosts = await listCollabHosts({ dir });
		} finally {
			connect.mockRestore();
		}
		await republished;

		// The stale query yields nothing, and the successor's files survived the prune.
		expect(hosts).toEqual([]);
		expect(await listCollabHosts({ dir })).toMatchObject([
			{ instanceId: "rotating-host", sessionId: "generation-2" },
		]);
		expect(await resolveCollabHostLink("rotating-host", "control", { dir })).toMatchObject({
			url: successor.controlUrl,
		});
	});

	it("removes metadata and socket and disappears from listings after close", async () => {
		const dir = await tempDir();
		const f = makeFixture();
		const pub = await publish(dir, f);
		expect(await listCollabHosts({ dir })).toHaveLength(1);
		await pub.close();

		expect(await listCollabHosts({ dir })).toEqual([]);
		expect((await fs.readdir(dir)).filter(n => n.endsWith(".json"))).toEqual([]);
		if (process.platform !== "win32") {
			await expect(fs.stat(pub.endpoint)).rejects.toMatchObject({ code: "ENOENT" });
		}
	});

	it("treats endpoint death as authoritative over a reused PID", async () => {
		const dir = await tempDir();
		const forgedFile = "reused-pid.json";
		await writeMetadata(dir, forgedFile, {
			version: COLLAB_REGISTRY_VERSION,
			pid: process.pid,
			endpoint: auxEndpoint(dir, "reused"),
			createdAt: Date.now(),
			token: crypto.randomBytes(16).toString("hex"),
		});

		expect(await listCollabHosts({ dir })).toEqual([]);
		expect(await Bun.file(path.join(dir, forgedFile)).exists()).toBe(false);
	});

	it("cannot duplicate a genuine host using a forged token and does not prune its live endpoint", async () => {
		const dir = await tempDir();
		const f = makeFixture({ sessionId: "genuine" });
		const pub = await publish(dir, f);
		await writeMetadata(dir, "forged.json", {
			version: COLLAB_REGISTRY_VERSION,
			pid: process.pid,
			endpoint: pub.endpoint,
			createdAt: Date.now(),
			token: crypto.randomBytes(16).toString("hex"),
		});

		expect((await listCollabHosts({ dir })).map(host => host.instanceId)).toEqual([f.snapshot.instanceId]);
		expect(await Bun.file(path.join(dir, "forged.json")).exists()).toBe(true);
		expect(await resolveCollabHostLink(f.snapshot.instanceId, "control", { dir })).toMatchObject({
			url: f.controlUrl,
		});
	});

	it.skipIf(process.platform === "win32")("creates an owner-only directory, metadata file, and socket", async () => {
		const dir = path.join(await tempDir(), "r");
		const f = makeFixture();
		const pub = await publish(dir, f);

		expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
		expect((await fs.stat(path.join(dir, `${f.snapshot.instanceId}.json`))).mode & 0o777).toBe(0o600);
		expect((await fs.stat(pub.endpoint)).mode & 0o777).toBe(0o600);
	});

	it.skipIf(process.platform === "win32")("tightens a pre-existing 0755 registry directory to 0700", async () => {
		const dir = await tempDir();
		await fs.chmod(dir, 0o755);
		await publish(dir, makeFixture());

		expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
	});

	it.skipIf(process.platform === "win32")(
		"refuses a symlinked registry directory instead of listing or pruning through it",
		async () => {
			// A planted symlink must not turn listing (which prunes malformed
			// `*.json`) into a way to delete files in an unrelated directory.
			const target = await tempDir();
			const bystander = path.join(target, "important.json");
			await Bun.write(bystander, "{not registry metadata");
			const link = path.join(await tempDir(), "collab-hosts");
			await fs.symlink(target, link);

			expect(await listCollabHosts({ dir: link })).toEqual([]);
			expect(await Bun.file(bystander).text()).toBe("{not registry metadata");
			await expect(publishCollabHost(sourceFor(makeFixture()), { dir: link })).rejects.toThrow(/symlink/);
			expect(await fs.readdir(target)).toEqual(["important.json"]);
		},
	);
});
