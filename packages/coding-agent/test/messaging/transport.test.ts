import { afterEach, describe, expect, it, vi } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	type InboxRequest,
	type InboxResponse,
	LINE_DEADLINE_MS,
	MAX_SERIALIZED_CHARS,
	MESSAGING_WIRE_VERSION,
	MessagingUnavailableError,
	parseInboxRequest,
	type SessionSnapshot,
	SEND_TIMEOUT_MS,
	SNAPSHOT_TIMEOUT_MS,
} from "../../src/messaging/protocol";
import {
	handleInboxConnection,
	type InboxAuth,
	type InboxPublication,
	listInboxEntries,
	publishInbox,
	requestInbox,
} from "../../src/messaging/transport";

const publications: InboxPublication[] = [];
const directories: TempDir[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const socket of sockets.splice(0)) socket.destroy();
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

function rawRequest(endpoint: string, lines: string): Promise<string> {
	const result = Promise.withResolvers<string>();
	const socket = net.createConnection({ path: endpoint });
	sockets.push(socket);
	let received = "";
	socket.setEncoding("utf8");
	socket.on("data", chunk => {
		received += chunk;
	});
	socket.once("connect", () => socket.write(lines));
	socket.once("error", () => socket.destroy());
	socket.once("end", () => socket.destroy());
	socket.once("close", () => result.resolve(received));
	return result.promise;
}

function framingSocket(requireAuth: boolean): {
	socket: net.Socket;
	handle: (request: InboxRequest, auth: InboxAuth) => Promise<InboxResponse>;
	responses: string[];
	responded: Promise<void>;
} {
	const socket = new net.Socket();
	sockets.push(socket);
	const handle = vi.fn(async (): Promise<InboxResponse> => ({ ok: true, outcome: "delivered" }));
	const responses: string[] = [];
	const responded = Promise.withResolvers<void>();
	vi.spyOn(socket, "end").mockImplementation((...args: unknown[]) => {
		responses.push(String(args[0]));
		responded.resolve();
		return socket;
	});
	handleInboxConnection(socket, handle, { sessionToken: "session", peerKey: "peer", requireAuth });
	return { socket, handle, responses, responded: responded.promise };
}

describe("inbox transport", () => {
	it("discovers two concurrent publications and round-trips a peer-authenticated snapshot", async () => {
		const dir = tempDir();
		const authSeen: InboxAuth[] = [];
		const handler = async (_request: InboxRequest, auth: InboxAuth): Promise<InboxResponse> => {
			authSeen.push(auth);
			return { ok: true, snapshot };
		};
		const [a, b] = await Promise.all([publish(dir, handler), publish(dir, handler)]);
		const entries = await listInboxEntries({ dir: a.registryDir });
		expect(entries.map(entry => entry.entryId).sort()).toEqual([a.entryId, b.entryId].sort());
		for (const entry of entries) {
			expect(Object.keys(entry).sort()).toEqual(["createdAt", "endpoint", "entryId", "pid", "sessionId", "version"]);
			expect(entry.version).toBe(MESSAGING_WIRE_VERSION);
		}
		expect(
			await requestInbox(
				entries.find(entry => entry.entryId === b.entryId)!,
				{ type: "snapshot" },
				{ dir: b.registryDir },
			),
		).toEqual({ ok: true, snapshot });
		expect(authSeen).toEqual(["peer"]);
		const metadata = await Bun.file(path.join(dir, `${a.entryId}.json`)).json();
		expect(metadata.version).toBe(MESSAGING_WIRE_VERSION);
		expect(metadata).not.toHaveProperty("token");
		expect(JSON.stringify(metadata)).not.toContain(a.token);
		expect(await Bun.file(path.join(dir, "peer.key")).text()).toMatch(/^[0-9a-f]{64}$/);
		if (process.platform !== "win32") {
			expect((await fs.stat(path.join(dir, "peer.key"))).mode & 0o777).toBe(0o600);
		}
	});

	it("lists and preserves a live version 2 inbox and parses its snapshot version", async () => {
		const dir = tempDir();
		const futureSnapshot: SessionSnapshot = { ...snapshot, v: 2 };
		const pub = await publish(dir, async () => ({ ok: true, snapshot: futureSnapshot }));
		const file = path.join(dir, `${pub.entryId}.json`);
		const metadata = { ...(await Bun.file(file).json()), version: 2 };
		await fs.writeFile(file, JSON.stringify(metadata), { mode: 0o600 });

		const [entry] = await listInboxEntries({ dir });
		expect(entry).toEqual({
			version: 2,
			sessionId: "receiver-session",
			entryId: pub.entryId,
			pid: process.pid,
			endpoint: pub.endpoint,
			createdAt: metadata.createdAt,
		});
		expect(await Bun.file(file).json()).toEqual(metadata);
		expect(await requestInbox(entry!, { type: "snapshot" }, { dir })).toEqual({
			ok: true,
			snapshot: futureSnapshot,
		});
		expect(await listInboxEntries({ dir })).toEqual([entry!]);
		expect(await Bun.file(file).exists()).toBe(true);
	});

	it("lists and exchanges messages with a 201-character session name", async () => {
		const dir = tempDir();
		const name = "x".repeat(201);
		const namedSnapshot: SessionSnapshot = { ...snapshot, name };
		const handler = vi.fn(async (request: InboxRequest): Promise<InboxResponse> =>
			request.type === "snapshot" ? { ok: true, snapshot: namedSnapshot } : { ok: true, outcome: "delivered" },
		);
		const pub = await publish(dir, handler);
		const [entry] = await listInboxEntries({ dir });
		expect(entry?.entryId).toBe(pub.entryId);
		expect(await requestInbox(entry!, { type: "snapshot" }, { dir })).toEqual({
			ok: true,
			snapshot: namedSnapshot,
		});
		const request: InboxRequest = {
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
		expect(await requestInbox(entry!, request, { dir })).toEqual({ ok: true, outcome: "delivered" });
		expect(handler).toHaveBeenCalledWith(request, "peer");
	});

	it("round-trips the queued outcome", async () => {
		const dir = tempDir();
		await publish(dir, async () => ({ ok: true, outcome: "queued" }));
		const [entry] = await listInboxEntries({ dir });
		expect(await requestInbox(entry!, { type: "message", id: "queued", body: "hello" }, { dir })).toEqual({
			ok: true,
			outcome: "queued",
		});
	});

	it("authenticates a script with the memory-only session token as own-child", async () => {
		const dir = tempDir();
		const handler = vi.fn(async (_request: InboxRequest, auth: InboxAuth): Promise<InboxResponse> => {
			expect(auth).toBe("own-child");
			return { ok: true, outcome: "delivered" };
		});
		const pub = await publish(dir, handler);
		expect(
			await rawRequest(
				pub.endpoint,
				`${JSON.stringify({ type: "auth", token: pub.token })}\n${JSON.stringify({ type: "message", id: "script", body: "hello" })}\n`,
			),
		).toBe('{"ok":true,"outcome":"delivered"}\n');
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it.skipIf(process.platform === "win32")("allows a POSIX request without an auth line as peer", async () => {
		const dir = tempDir();
		const handler = vi.fn(async (_request: InboxRequest, auth: InboxAuth): Promise<InboxResponse> => {
			expect(auth).toBe("peer");
			return { ok: true, snapshot };
		});
		const pub = await publish(dir, handler);
		expect(JSON.parse(await rawRequest(pub.endpoint, '{"type":"snapshot"}\n'))).toEqual({ ok: true, snapshot });
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("closes a wrong-token connection without responding or invoking the handler", async () => {
		const dir = tempDir();
		const handler = vi.fn(async (): Promise<InboxResponse> => ({ ok: true, snapshot }));
		const pub = await publish(dir, handler);
		expect(await rawRequest(pub.endpoint, '{"type":"auth","token":"wrong"}\n{"type":"snapshot"}\n')).toBe("");
		expect(handler).not.toHaveBeenCalled();
	});

	it("requires Windows first-line auth without modifying the process platform", () => {
		vi.useFakeTimers();
		const { socket, handle, responses } = framingSocket(true);
		socket.emit("data", '{"type":"message","id":"one","body":"hello"}\n');
		expect(socket.destroyed).toBe(true);
		expect(responses).toEqual([]);
		expect(handle).not.toHaveBeenCalled();
	});

	it("enforces a fixed 30-second line deadline despite trickled bytes", () => {
		vi.useFakeTimers();
		const { socket, handle } = framingSocket(false);
		socket.emit("data", '{"type":"message"');
		vi.advanceTimersByTime(LINE_DEADLINE_MS - 1);
		expect(socket.destroyed).toBe(false);
		socket.emit("data", ',"id":');
		vi.advanceTimersByTime(1);
		expect(socket.destroyed).toBe(true);
		expect(handle).not.toHaveBeenCalled();
	});

	it("starts a fresh fixed line deadline after a complete auth line", () => {
		vi.useFakeTimers();
		const { socket, handle } = framingSocket(true);
		vi.advanceTimersByTime(20_000);
		socket.emit("data", '{"type":"auth","token":"session"}\n{"type":');
		vi.advanceTimersByTime(LINE_DEADLINE_MS - 1);
		expect(socket.destroyed).toBe(false);
		vi.advanceTimersByTime(1);
		expect(socket.destroyed).toBe(true);
		expect(handle).not.toHaveBeenCalled();
	});

	it("claims one request before awaiting its handler and ignores subsequent requests", async () => {
		vi.useFakeTimers();
		const { socket, handle, responses, responded } = framingSocket(true);
		socket.emit("data", '{"type":"auth","token":"peer"}\n{"type":"snapshot"}\n{"type":"snapshot"}\n');
		await responded;
		expect(handle).toHaveBeenCalledTimes(1);
		expect(handle).toHaveBeenCalledWith({ type: "snapshot" }, "peer");
		expect(responses).toEqual(['{"ok":true,"outcome":"delivered"}\n']);
	});

	it("destroys malformed JSON without handing it to the session", async () => {
		const dir = tempDir();
		const handler = vi.fn(async (): Promise<InboxResponse> => ({ ok: true, snapshot }));
		const pub = await publish(dir, handler);
		expect(await rawRequest(pub.endpoint, `${JSON.stringify({ type: "auth", token: pub.token })}\nnot JSON\n`)).toBe(
			"",
		);
		expect(handler).not.toHaveBeenCalled();
	});

	it("does not leak handler exceptions into the response", async () => {
		const dir = tempDir();
		const pub = await publish(dir, async () => {
			throw new Error("secret capability");
		});
		const [entry] = await listInboxEntries({ dir });
		expect(await requestInbox(entry!, { type: "snapshot" }, { dir })).toEqual({ ok: false, error: "internal" });
		await Promise.all([pub.close(), pub.close()]);
		expect(await listInboxEntries({ dir })).toEqual([]);
	});

	it("refuses oversized serialized requests at the sender and receiver without delivery", async () => {
		const dir = tempDir();
		const handler = vi.fn(async (): Promise<InboxResponse> => ({ ok: true, outcome: "delivered" }));
		const pub = await publish(dir, handler);
		const [entry] = await listInboxEntries({ dir });
		const request: InboxRequest = { type: "message", id: "large", body: "x".repeat(MAX_SERIALIZED_CHARS) };
		expect(await requestInbox(entry!, request, { dir })).toEqual({ ok: false, error: "too_large" });
		expect(
			JSON.parse(
				await rawRequest(
					pub.endpoint,
					`${JSON.stringify({ type: "auth", token: pub.token })}\n${JSON.stringify(request)}\n`,
				),
			),
		).toEqual({ ok: false, error: "too_large" });
		expect(handler).not.toHaveBeenCalled();
	});

	it.skipIf(process.platform === "win32")(
		"refuses a symlink endpoint with the exact user-facing safety error",
		async () => {
			const dir = tempDir();
			const handler = vi.fn(async (): Promise<InboxResponse> => ({ ok: true, snapshot }));
			const pub = await publish(dir, handler);
			const [entry] = await listInboxEntries({ dir });
			const link = path.join(dir, "reply.sock");
			await fs.symlink(pub.endpoint, link);
			expect(await requestInbox({ ...entry!, endpoint: link }, { type: "snapshot" }, { dir })).toEqual({
				ok: false,
				error: "Refusing to send: reply target is a symlink",
			});
			expect(handler).not.toHaveBeenCalled();
		},
	);

	it.skipIf(process.platform === "win32")(
		"refuses a non-socket endpoint and reports a vanished socket as unreachable",
		async () => {
			const dir = tempDir();
			const pub = await publish(dir, async () => ({ ok: true, snapshot }));
			const [entry] = await listInboxEntries({ dir });
			const regular = path.join(dir, "not-a-socket");
			await Bun.write(regular, "data");
			expect(await requestInbox({ ...entry!, endpoint: regular }, { type: "snapshot" }, { dir })).toEqual({
				ok: false,
				error: "Refusing to send: cannot vet reply target",
			});
			expect(
				await requestInbox({ ...entry!, endpoint: `${pub.endpoint}-missing` }, { type: "snapshot" }, { dir }),
			).toEqual({ ok: false, error: "unreachable" });
		},
	);

	it.each([
		{ request: { type: "snapshot" } as InboxRequest, timeout: SNAPSHOT_TIMEOUT_MS },
		{ request: { type: "message", id: "one", body: "hello" } as InboxRequest, timeout: SEND_TIMEOUT_MS },
	])("returns unreachable at the default $timeout ms request deadline", async ({ request, timeout }) => {
		const dir = tempDir();
		await publish(dir, async () => ({ ok: true, snapshot }));
		const [entry] = await listInboxEntries({ dir });
		const connecting = Promise.withResolvers<void>();
		const socket = new net.Socket();
		sockets.push(socket);
		vi.spyOn(net, "createConnection").mockImplementation(() => {
			connecting.resolve();
			return socket;
		});
		vi.useFakeTimers();
		let settled = false;
		const result = requestInbox(entry!, request, { dir }).then(response => {
			settled = true;
			return response;
		});
		await connecting.promise;
		vi.advanceTimersByTime(timeout - 1);
		expect(settled).toBe(false);
		vi.advanceTimersByTime(1);
		expect(await result).toEqual({ ok: false, error: "unreachable" });
	});

	it.skipIf(process.platform === "win32")(
		"publishes in the uid fallback rather than following a symlink registry",
		async () => {
			const dir = tempDir();
			const link = path.join(dir, "unsafe");
			await fs.symlink(dir, link, "dir");
			const pub = await publish(link, async () => ({ ok: true, snapshot }));
			expect(path.dirname(pub.endpoint)).toBe(`/tmp/omp-socks-${process.getuid!()}`);
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
			).rejects.toMatchObject({
				name: "MessagingUnavailableError",
				reason: "foreign directory owner",
			});
			expect(stat).toHaveBeenCalledWith(dir);
			expect(stat).toHaveBeenCalledWith(`/tmp/omp-socks-${process.getuid!()}`);
		},
	);

	it("prunes a dead inbox entry left behind after a process exits", async () => {
		const dir = tempDir();
		const pub = await publish(dir, async () => ({ ok: true, snapshot }));
		const file = path.join(dir, `${pub.entryId}.json`);
		const metadata = await Bun.file(file).text();
		await pub.close();
		await fs.writeFile(file, metadata, { mode: 0o600 });
		expect(await listInboxEntries({ dir })).toEqual([]);
		expect(await Bun.file(file).exists()).toBe(false);
	});

	it("prunes unparseable inbox metadata", async () => {
		const dir = tempDir();
		const file = path.join(dir, "12345678.json");
		await fs.writeFile(file, "not JSON", { mode: 0o600 });
		expect(await listInboxEntries({ dir })).toEqual([]);
		expect(await Bun.file(file).exists()).toBe(false);
	});

	it("surfaces a corrupt peer key as unavailable instead of replacing its identity", async () => {
		const dir = tempDir();
		await fs.writeFile(path.join(dir, "peer.key"), "corrupt", { mode: 0o600 });
		await expect(
			publishInbox(async () => ({ ok: true, snapshot }), { dir, sessionId: "receiver-session" }),
		).rejects.toBeInstanceOf(MessagingUnavailableError);
		expect(await Bun.file(path.join(dir, "peer.key")).text()).toBe("corrupt");
		expect((await fs.readdir(dir)).filter(name => name.endsWith(".json"))).toEqual([]);
	});
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

it("rejects snapshots lacking safe persistent identities instead of promoting their short id", async () => {
	const dir = tempDir();
	const pub = await publish(dir, async () => ({ ok: true, snapshot: { ...snapshot, sessionId: "../other" } }));
	const [entry] = await listInboxEntries({ dir });
	expect(entry?.entryId).toBe(pub.entryId);
	expect(await requestInbox(entry!, { type: "snapshot" }, { dir })).toEqual({ ok: false, error: "invalid_response" });
});

it.skipIf(process.platform === "win32")(
	"keeps metadata at the selected registry root when only the socket path must be shortened",
	async () => {
		const dir = path.join(tempDir(), "long-" + "x".repeat(150));
		const pub = await publish(dir, async () => ({ ok: true, snapshot }));
		expect(path.dirname(pub.endpoint)).not.toBe(dir);
		const entries = await listInboxEntries({ dir: pub.registryDir });
		const entry = entries.find(item => item.entryId === pub.entryId);
		expect(entry).toBeDefined();
		expect(await requestInbox(entry!, { type: "snapshot" }, { dir: pub.registryDir })).toEqual({
			ok: true,
			snapshot,
		});
		expect(await Bun.file(path.join(dir, `${pub.entryId}.json`)).exists()).toBe(true);
	},
);
