import { afterEach, describe, expect, it, vi } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IpcConnection, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	type InboxRequest,
	type InboxResponse,
	MAX_SERIALIZED_CHARS,
	MESSAGING_WIRE_VERSION,
	parseInboxRequest,
	type SessionSnapshot,
} from "../../src/messaging/protocol";
import {
	type InboxAuth,
	type InboxPublication,
	listInboxEntries,
	publishInbox,
	readInboxEntries,
	requestInbox,
} from "../../src/messaging/transport";

const publications: InboxPublication[] = [];
const directories: TempDir[] = [];
const connections: IpcConnection[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const connection of connections.splice(0)) connection.destroy();
	for (const pub of publications.splice(0)) await pub.close();
	for (const dir of directories.splice(0)) dir[Symbol.dispose]();
});

function tempDir(): string {
	const dir = TempDir.createSync("@omp-inbox-");
	directories.push(dir);
	return dir.path();
}

async function publish(
	dir: string,
	handle: (request: InboxRequest, auth: InboxAuth) => Promise<InboxResponse>,
): Promise<InboxPublication> {
	const pub = await publishInbox(handle, { dir, sessionId: "receiver-session" });
	publications.push(pub);
	return pub;
}

const snapshot: SessionSnapshot = {
	v: MESSAGING_WIRE_VERSION,
	sessionId: "receiver-session",
	name: "receiver",
	shortId: "12345678",
	title: "Working session",
	cwd: "/workspace",
	busy: false,
	pid: process.pid,
	startedAt: 1_700_000_000_000,
};

async function connect(endpoint: string): Promise<IpcConnection> {
	const connection = await IpcConnection.connect(endpoint, { framing: "lines" });
	connections.push(connection);
	return connection;
}

async function rawRequest(endpoint: string, lines: string[]): Promise<string[]> {
	const connection = await connect(endpoint);
	const closed = Promise.withResolvers<string[]>();
	const responses: string[] = [];
	connection.start(
		line => responses.push(line),
		() => closed.resolve(responses),
	);
	for (const line of lines) connection.send(line);
	return closed.promise;
}

describe("inbox transport", () => {
	it("discovers two concurrent publications and round-trips a snapshot", async () => {
		const dir = tempDir();
		const [a, b] = await Promise.all([
			publish(dir, async () => ({ ok: true, snapshot })),
			publish(dir, async () => ({ ok: true, snapshot })),
		]);
		const entries = await listInboxEntries({ dir });
		expect(entries.map(entry => entry.entryId).sort()).toEqual([a.entryId, b.entryId].sort());
		for (const entry of entries) {
			expect(Object.keys(entry).sort()).toEqual(["createdAt", "endpoint", "entryId", "pid", "sessionId", "version"]);
			expect(entry.version).toBe(MESSAGING_WIRE_VERSION);
		}
		expect(
			await requestInbox(
				entries.find(entry => entry.entryId === b.entryId)!,
				{ type: "snapshot" },
				{ dir },
			),
		).toEqual({ ok: true, snapshot });
		const metadata = await Bun.file(path.join(dir, `${a.entryId}.json`)).json();
		expect(metadata).not.toHaveProperty("token");
		expect(JSON.stringify(metadata)).not.toContain(a.token);
	});

	it("probes a live foreign-version inbox on every platform", async () => {
		const dir = tempDir();
		const futureSnapshot: SessionSnapshot = { ...snapshot, v: MESSAGING_WIRE_VERSION + 1 };
		const pub = await publish(dir, async () => ({ ok: true, snapshot: futureSnapshot }));
		const file = path.join(dir, `${pub.entryId}.json`);
		const metadata = { ...(await Bun.file(file).json()), version: MESSAGING_WIRE_VERSION + 1 };
		await fs.writeFile(file, JSON.stringify(metadata), { mode: 0o600 });
		const [entry] = await listInboxEntries({ dir });
		expect(entry?.version).toBe(MESSAGING_WIRE_VERSION + 1);
		expect(await requestInbox(entry!, { type: "snapshot" }, { dir })).toEqual({ ok: true, snapshot: futureSnapshot });
		expect(await Bun.file(file).json()).toEqual(metadata);
	});

	it.each(["name", "title"] as const)("caps snapshot %s at 4096 characters without truncating", async field => {
		const dir = tempDir();
		let current = { ...snapshot, [field]: "x".repeat(4096) };
		await publish(dir, async () => ({ ok: true, snapshot: current }));
		const [entry] = await readInboxEntries({ dir });
		expect(await requestInbox(entry!, { type: "snapshot" }, { dir })).toEqual({ ok: true, snapshot: current });
		current = { ...current, [field]: "x".repeat(4097) };
		expect(await requestInbox(entry!, { type: "snapshot" }, { dir })).toEqual({
			ok: false,
			error: "invalid_response",
		});
	});

	it("rejects snapshots lacking safe persistent identities instead of promoting their short id", async () => {
		const dir = tempDir();
		await publish(dir, async () => ({ ok: true, snapshot: { ...snapshot, sessionId: "../other" } }));
		const [entry] = await readInboxEntries({ dir });
		expect(await requestInbox(entry!, { type: "snapshot" }, { dir })).toEqual({
			ok: false,
			error: "invalid_response",
		});
	});

	it.each(["delivered", "queued"] as const)(
		"exchanges %s messages with a 201-character session name",
		async outcome => {
			const dir = tempDir();
			const name = "x".repeat(201);
			const namedSnapshot: SessionSnapshot = { ...snapshot, name };
			const handler = vi.fn(async (request: InboxRequest): Promise<InboxResponse> =>
				request.type === "snapshot" ? { ok: true, snapshot: namedSnapshot } : { ok: true, outcome },
			);
			const pub = await publish(dir, handler);
			const [entry] = await readInboxEntries({ dir });
			expect(await requestInbox(entry!, { type: "snapshot" }, { dir })).toEqual({
				ok: true,
				snapshot: namedSnapshot,
			});
			const request: InboxRequest =
				outcome === "queued"
					? { type: "message", id: "queued", body: "hello" }
					: {
							type: "message",
							id: "long-name",
							from: {
								sessionId: "sender-session",
								name,
								shortId: "abcdef12",
								cwd: "/workspace",
								entryId: pub.entryId,
								class: "bypass",
							},
							body: "hello",
						};
			expect(await requestInbox(entry!, request, { dir })).toEqual({ ok: true, outcome });
			expect(handler).toHaveBeenCalledWith(request, "peer");
		},
	);

	it("authenticates a script with the session token as own-child", async () => {
		const handler = vi.fn(async (): Promise<InboxResponse> => ({ ok: true, outcome: "delivered" }));
		const pub = await publish(tempDir(), handler);
		const request: InboxRequest = { type: "message", id: "script", body: "hello" };
		expect(
			await rawRequest(pub.endpoint, [JSON.stringify({ type: "auth", token: pub.token }), JSON.stringify(request)]),
		).toEqual(['{"ok":true,"outcome":"delivered"}']);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler).toHaveBeenCalledWith(request, "own-child");
	});

	it("accepts a request without an auth line as peer on every platform", async () => {
		const handler = vi.fn(async (): Promise<InboxResponse> => ({ ok: true, snapshot }));
		const pub = await publish(tempDir(), handler);
		expect(await rawRequest(pub.endpoint, ['{"type":"snapshot"}'])).toEqual([JSON.stringify({ ok: true, snapshot })]);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler).toHaveBeenCalledWith({ type: "snapshot" }, "peer");
	});

	it("closes a wrong-token auth line without responding or invoking the handler", async () => {
		const handler = vi.fn(async (): Promise<InboxResponse> => ({ ok: true, snapshot }));
		const pub = await publish(tempDir(), handler);
		expect(await rawRequest(pub.endpoint, ['{"type":"auth","token":"wrong"}', '{"type":"snapshot"}'])).toEqual([]);
		expect(handler).not.toHaveBeenCalled();
	});

	it("closes invalid JSON without responding or invoking the handler", async () => {
		const handler = vi.fn(async (): Promise<InboxResponse> => ({ ok: true, snapshot }));
		const pub = await publish(tempDir(), handler);
		expect(await rawRequest(pub.endpoint, ["not JSON"])).toEqual([]);
		expect(handler).not.toHaveBeenCalled();
	});

	it("closes a non-request first line without invoking the handler", async () => {
		const handler = vi.fn(async (): Promise<InboxResponse> => ({ ok: true, snapshot }));
		const pub = await publish(tempDir(), handler);
		expect(await rawRequest(pub.endpoint, ['{"type":"unknown"}', '{"type":"snapshot"}'])).toEqual([]);
		expect(handler).not.toHaveBeenCalled();
	});

	it("claims one request before awaiting its handler and ignores subsequent requests", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const handler = vi.fn(async (): Promise<InboxResponse> => {
			entered.resolve();
			await release.promise;
			return { ok: true, snapshot };
		});
		const pub = await publish(tempDir(), handler);
		const response = rawRequest(pub.endpoint, ['{"type":"snapshot"}', '{"type":"snapshot"}']);
		try {
			await entered.promise;
			expect(handler).toHaveBeenCalledTimes(1);
			release.resolve();
			expect(await response).toEqual([JSON.stringify({ ok: true, snapshot })]);
			expect(handler).toHaveBeenCalledTimes(1);
		} finally {
			release.resolve();
		}
	});

	it("does not leak handler exceptions into the response", async () => {
		const dir = tempDir();
		await publish(dir, async () => {
			throw new Error("secret capability");
		});
		const [entry] = await readInboxEntries({ dir });
		expect(await requestInbox(entry!, { type: "snapshot" }, { dir })).toEqual({ ok: false, error: "internal" });
	});

	it("responds too_large to an over-cap request line without delivery", async () => {
		const handler = vi.fn(async (): Promise<InboxResponse> => ({ ok: true, outcome: "delivered" }));
		const pub = await publish(tempDir(), handler);
		const base = { type: "message", id: "large", body: "" };
		const request = { ...base, body: "x".repeat(MAX_SERIALIZED_CHARS + 1 - JSON.stringify(base).length) };
		const line = JSON.stringify(request);
		expect(line.length).toBe(MAX_SERIALIZED_CHARS + 1);
		expect(await rawRequest(pub.endpoint, [line])).toEqual(['{"ok":false,"error":"too_large"}']);
		expect(handler).not.toHaveBeenCalled();
	});

	it("accepts the multibyte character limit and rejects cap+1 before connecting", async () => {
		const dir = tempDir();
		const handler = vi.fn(async (): Promise<InboxResponse> => ({ ok: true, outcome: "delivered" }));
		await publish(dir, handler);
		const [entry] = await readInboxEntries({ dir });
		const base: InboxRequest = { type: "message", id: "multibyte", body: "" };
		const request = { ...base, body: "界".repeat(MAX_SERIALIZED_CHARS - JSON.stringify(base).length) };
		const line = JSON.stringify(request);
		expect(line.length).toBe(MAX_SERIALIZED_CHARS);
		expect(Buffer.byteLength(line)).toBeGreaterThan(MAX_SERIALIZED_CHARS);
		expect(await requestInbox(entry!, request, { dir, timeoutMs: 2_000 })).toEqual({
			ok: true,
			outcome: "delivered",
		});
		expect(handler).toHaveBeenCalledWith(request, "peer");
		const oversized = { ...request, body: `${request.body}界` };
		expect(JSON.stringify(oversized).length).toBe(MAX_SERIALIZED_CHARS + 1);
		const connecting = vi.spyOn(IpcConnection, "connect");
		expect(await requestInbox(entry!, oversized, { dir })).toEqual({ ok: false, error: "too_large" });
		expect(connecting).not.toHaveBeenCalled();
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("reports timeout, not unreachable, when a live listener never answers", async () => {
		const dir = tempDir();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const pub = await publish(dir, async () => {
			entered.resolve();
			await release.promise;
			return { ok: true, snapshot };
		});
		const [entry] = await readInboxEntries({ dir });
		try {
			const result = await requestInbox(entry!, { type: "snapshot" }, { dir, timeoutMs: 100 });
			await entered.promise;
			expect(result).toEqual({ ok: false, error: "timeout" });
			expect(await readInboxEntries({ dir })).toEqual([entry!]);
			expect(await Bun.file(path.join(dir, `${pub.entryId}.json`)).exists()).toBe(true);
		} finally {
			release.resolve();
		}
	});

	it("reports unreachable for an absent endpoint after its metadata is pruned", async () => {
		const dir = tempDir();
		const pub = await publish(dir, async () => ({ ok: true, snapshot }));
		const [entry] = await readInboxEntries({ dir });
		const file = path.join(dir, `${pub.entryId}.json`);
		const metadata = await Bun.file(file).text();
		await pub.close();
		await fs.writeFile(file, metadata, { mode: 0o600 });
		expect(await listInboxEntries({ dir })).toEqual([]);
		expect(await Bun.file(file).exists()).toBe(false);
		expect(await requestInbox(entry!, { type: "snapshot" }, { dir })).toEqual({ ok: false, error: "unreachable" });
	});

	it("destroys an in-flight connection and removes native endpoint files on close", async () => {
		const dir = tempDir();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const pub = await publish(dir, async () => {
			entered.resolve();
			await release.promise;
			return { ok: true, snapshot };
		});
		const [entry] = await readInboxEntries({ dir });
		try {
			const result = requestInbox(entry!, { type: "snapshot" }, { dir, timeoutMs: 2_000 });
			await entered.promise;
			if (process.platform !== "win32") {
				expect((await fs.lstat(pub.endpoint)).isSocket()).toBe(true);
				expect((await fs.lstat(`${pub.endpoint}.bind.lock`)).isFile()).toBe(true);
			}
			await pub.close();
			expect(await result).toEqual({ ok: false, error: "unreachable" });
			if (process.platform !== "win32") {
				await expect(fs.lstat(pub.endpoint)).rejects.toMatchObject({ code: "ENOENT" });
				await expect(fs.lstat(`${pub.endpoint}.bind.lock`)).rejects.toMatchObject({ code: "ENOENT" });
			}
		} finally {
			release.resolve();
		}
	});

	it("closes the 65th connection while keeping 64 idle clients live", async () => {
		const handler = vi.fn(async (): Promise<InboxResponse> => ({ ok: true, snapshot }));
		const pub = await publish(tempDir(), handler);
		let idleCloses = 0;
		for (let i = 0; i < 64; i++) {
			const connection = await connect(pub.endpoint);
			connection.start(
				() => {},
				() => idleCloses++,
			);
		}
		expect(await rawRequest(pub.endpoint, [])).toEqual([]);
		expect(idleCloses).toBe(0);
		expect(handler).not.toHaveBeenCalled();
	});

	it.skipIf(process.platform === "win32")("refuses a symlink endpoint with the exact safety error", async () => {
		const dir = tempDir();
		const handler = vi.fn(async (): Promise<InboxResponse> => ({ ok: true, snapshot }));
		const pub = await publish(dir, handler);
		const [entry] = await readInboxEntries({ dir });
		const link = path.join(dir, "reply.sock");
		await fs.symlink(pub.endpoint, link);
		expect(await requestInbox({ ...entry!, endpoint: link }, { type: "snapshot" }, { dir })).toEqual({
			ok: false,
			error: "Refusing to send: reply target is a symlink",
		});
		expect(handler).not.toHaveBeenCalled();
	});

	it.skipIf(process.platform === "win32")("refuses a non-socket endpoint", async () => {
		const dir = tempDir();
		await publish(dir, async () => ({ ok: true, snapshot }));
		const [entry] = await readInboxEntries({ dir });
		const regular = path.join(dir, "not-a-socket");
		await Bun.write(regular, "data");
		expect(await requestInbox({ ...entry!, endpoint: regular }, { type: "snapshot" }, { dir })).toEqual({
			ok: false,
			error: "Refusing to send: cannot vet reply target",
		});
	});

	it.skipIf(process.platform === "win32")("refuses an endpoint owned by another user", async () => {
		const dir = tempDir();
		const handler = vi.fn(async (): Promise<InboxResponse> => ({ ok: true, snapshot }));
		const pub = await publish(dir, handler);
		const [entry] = await readInboxEntries({ dir });
		const foreign = Object.assign(await fs.lstat(pub.endpoint), { uid: process.getuid!() + 1 });
		const lstat = nodeFs.promises.lstat;
		vi.spyOn(nodeFs.promises, "lstat").mockImplementation((async (...args: Parameters<typeof lstat>) =>
			String(args[0]) === pub.endpoint ? foreign : lstat(...args)) as typeof lstat);
		expect(await requestInbox(entry!, { type: "snapshot" }, { dir })).toEqual({
			ok: false,
			error: "Refusing to send: cannot vet reply target",
		});
		expect(handler).not.toHaveBeenCalled();
	});

	it.skipIf(process.platform === "win32")(
		"selects the uid fallback rather than following a symlink registry",
		async () => {
			const dir = tempDir();
			const link = path.join(dir, "unsafe");
			await fs.symlink(dir, link, "dir");
			const pub = await publish(link, async () => ({ ok: true, snapshot }));
			const fallback = `/tmp/omp-socks-${process.getuid!()}`;
			expect(pub.registryDir).toBe(fallback);
			expect(pub.endpoint).toBe(ipcEndpoint(fallback, pub.entryId));
			const entries = await listInboxEntries({ dir: link });
			const entry = entries.find(candidate => candidate.entryId === pub.entryId);
			expect(entry).toBeDefined();
			expect(await requestInbox(entry!, { type: "snapshot" }, { dir: link })).toEqual({ ok: true, snapshot });
		},
	);

	it.skipIf(process.platform === "win32")(
		"discovers and sends to a fallback-only inbox when the canonical directory is absent",
		async () => {
			const dir = path.join(tempDir(), "missing");
			const fallback = `/tmp/omp-socks-${process.getuid!()}`;
			const pub = await publish(fallback, async () => ({ ok: true, snapshot }));
			const entries = await listInboxEntries({ dir });
			const entry = entries.find(candidate => candidate.entryId === pub.entryId);
			expect(entry).toBeDefined();
			expect(await requestInbox(entry!, { type: "snapshot" }, { dir })).toEqual({ ok: true, snapshot });
			await expect(fs.lstat(dir)).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it.skipIf(process.platform === "win32")(
		"reports unavailable when neither canonical nor uid fallback directory is acceptable",
		async () => {
			const dir = tempDir();
			const stat = vi.spyOn(nodeFs.promises, "lstat").mockRejectedValue(new Error("foreign directory owner"));
			await expect(
				publishInbox(async () => ({ ok: true, snapshot }), { dir, sessionId: "receiver-session" }),
			).rejects.toMatchObject({ name: "MessagingUnavailableError", reason: "foreign directory owner" });
			expect(stat).toHaveBeenCalledWith(dir);
			expect(stat).toHaveBeenCalledWith(`/tmp/omp-socks-${process.getuid!()}`);
		},
	);

	it.skipIf(process.platform === "win32")(
		"keeps metadata at the selected registry root when native IPC shortens the endpoint",
		async () => {
			const dir = path.join(tempDir(), "long-" + "x".repeat(150));
			const pub = await publish(dir, async () => ({ ok: true, snapshot }));
			expect(pub.registryDir).toBe(dir);
			expect(pub.endpoint).toBe(ipcEndpoint(dir, pub.entryId));
			expect(path.dirname(pub.endpoint)).not.toBe(dir);
			const [entry] = await listInboxEntries({ dir });
			expect(entry?.entryId).toBe(pub.entryId);
			expect(await requestInbox(entry!, { type: "snapshot" }, { dir })).toEqual({ ok: true, snapshot });
			expect(await Bun.file(path.join(dir, `${pub.entryId}.json`)).exists()).toBe(true);
		},
	);
});

describe("inbox request boundary", () => {
	const sender = {
		sessionId: "sender-session",
		name: "sender",
		shortId: "abcdef12",
		cwd: "/workspace",
		entryId: "87654321",
		class: "bypass",
	} as const;
	it.each(["message", "subscribe", "notice"] as const)("caps the %s sender name at 4096 characters", type => {
		const request = {
			type,
			id: "boundary",
			from: { ...sender, name: "x".repeat(4096) },
			...(type === "message" ? { body: "hello" } : type === "notice" ? { kind: "idle" } : {}),
		};
		expect<unknown>(parseInboxRequest(request)).toEqual(request);
		expect(parseInboxRequest({ ...request, from: { ...request.from, name: "x".repeat(4097) } })).toBeUndefined();
		expect(parseInboxRequest({ ...request, from: { ...sender, name: null } })).toBeDefined();
	});

	it("caps an idle status at 4096 characters without truncating", () => {
		const request = { type: "notice", id: "boundary", from: sender, kind: "idle", status: "x".repeat(4096) };
		expect<unknown>(parseInboxRequest(request)).toEqual(request);
		expect(parseInboxRequest({ ...request, status: "x".repeat(4097) })).toBeUndefined();
	});

	it.each(["message", "subscription", undefined] as const)("accepts a retired notice with subject %s", subject => {
		const notice: Extract<InboxRequest, { type: "notice" }> = {
			type: "notice",
			id: "retired",
			from: sender,
			kind: "retired",
			aboutId: "original",
			...(subject === undefined ? {} : { subject }),
		};
		expect(parseInboxRequest(notice)).toEqual(notice);
	});

	it("requires full safe sender identity and a message-targeted refusal notice", () => {
		const notice: Extract<InboxRequest, { kind: "refused" }> = {
			type: "notice",
			id: "refused-original",
			from: sender,
			kind: "refused",
			subject: "message",
			aboutId: "original",
			toSessionId: "receiver-session",
		};
		expect(parseInboxRequest(notice)).toEqual(notice);
		for (const change of [
			{ toSessionId: undefined },
			{ toSessionId: "../escape" },
			{ subject: "subscription" },
			{ aboutId: undefined },
			{ from: { ...sender, sessionId: undefined } },
			{ from: { ...sender, sessionId: ".." } },
		])
			expect(parseInboxRequest({ ...notice, ...change })).toBeUndefined();
		const { sessionId: _id, ...withoutFullId } = sender;
		expect(
			parseInboxRequest({ type: "message", id: "original", body: "hello", from: withoutFullId }),
		).toBeUndefined();
	});

	it.each([
		["array envelope", []],
		["extra recipient", { type: "snapshot", recipient: "subagent" }],
		["missing id", { type: "message", body: "hello" }],
		["non-string body", { type: "message", id: "one", body: 4 }],
		["non-string name", { type: "subscribe", id: "one", from: { ...sender, name: 201 } }],
		["oversized cwd", { type: "subscribe", id: "one", from: { ...sender, cwd: "x".repeat(4097) } }],
		["invalid short id", { type: "subscribe", id: "one", from: { ...sender, shortId: "ABCDEF12" } }],
		["unknown permission class", { type: "subscribe", id: "one", from: { ...sender, class: "unknown" } }],
		["too many chain entries", { type: "message", id: "one", body: "hello", chain: Array(65).fill("abcdef12") }],
		["invalid chain id", { type: "message", id: "one", body: "hello", chain: ["invalid"] }],
		["non-boolean notify", { type: "message", id: "one", body: "hello", notifyWhenIdle: "idle" }],
		["array notice kind", { type: "notice", id: "one", from: sender, kind: ["idle"] }],
		["unknown drop reason", { type: "notice", id: "one", from: sender, kind: "dropped", reason: "unknown" }],
		["unknown notice subject", { type: "notice", id: "one", from: sender, kind: "retired", subject: "unknown" }],
		["non-string notice subject", { type: "notice", id: "one", from: sender, kind: "retired", subject: 1 }],
	])("rejects %s rather than admitting malformed or extra fields", (_name, value) => {
		expect(parseInboxRequest(value)).toBeUndefined();
	});
});
