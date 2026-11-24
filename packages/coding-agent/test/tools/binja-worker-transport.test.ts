/**
 * The socket protocol of the Binary Ninja worker (`src/binja/worker.py`), run against a stand-in
 * `binaryninja` package (`test/fixtures/binaryninja-stub`). The worker binds its listener and
 * installs its signal handlers before it imports the engine, so everything here but the engine
 * calls is the shipped code: authentication, connection replacement, request errors, interrupts,
 * the undo span around edits, `close` and SIGTERM.
 *
 * It needs only a Python 3, so unlike `binja-worker.test.ts` it runs where Binary Ninja is not
 * installed, and it speaks the protocol itself, which reaches what the supervisor only uses on
 * Windows: the loopback listener (`--port-file`) and interrupt frames.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { DISASM_BACKENDS } from "@oh-my-pi/pi-coding-agent/disasm/backend";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import { waitFor } from "../fixtures/daemon-harness";

const PYTHON = Bun.which("python3") ?? Bun.which("python");
const STUB = path.join(import.meta.dir, "..", "fixtures", "binaryninja-stub");
const TOKEN = "transport-test-token";
const TEST_TIMEOUT_MS = 30_000;
/** What the stub writes as a new database, and appends on every save. */
const NEW_DATABASE = "omp-binaryninja-stub\n";
const SAVED = "saved\n";
const INTERRUPTED = "KeyboardInterrupt: interrupted (timeout or cancel)";
/** Python's `AF_UNIX` is not available on Windows; the supervisor uses the loopback listener there. */
const LISTENERS = process.platform === "win32" ? (["port-file"] as const) : (["port-file", "socket"] as const);

type Listener = (typeof LISTENERS)[number];

interface Frame {
	id: number | null;
	ok: boolean;
	result?: Record<string, unknown>;
	error?: { type: string; message: string };
	dirty?: boolean;
}

/** A protocol client: one authenticated (or not) connection to a worker. */
class Client {
	/** Frames that answer no request of this client, such as the answer to a malformed line. */
	readonly unmatched: Frame[] = [];
	readonly closed: Promise<void>;
	#conn: IpcConnection;
	#pending = new Map<number, PromiseWithResolvers<Frame>>();
	#nextId = 1;

	constructor(conn: IpcConnection) {
		this.#conn = conn;
		const closed = Promise.withResolvers<void>();
		this.closed = closed.promise;
		conn.start(
			line => {
				const frame = JSON.parse(line) as Frame;
				const pending = typeof frame.id === "number" ? this.#pending.get(frame.id) : undefined;
				if (!pending || typeof frame.id !== "number") {
					this.unmatched.push(frame);
					return;
				}
				this.#pending.delete(frame.id);
				pending.resolve(frame);
			},
			() => closed.resolve(),
		);
	}

	static async connect(endpoint: number | string, token: string): Promise<Client> {
		const options = { framing: "lines" as const, timeoutMs: 5_000 };
		const conn =
			typeof endpoint === "number"
				? await IpcConnection.connectTcp("127.0.0.1", endpoint, options)
				: await IpcConnection.connect(endpoint, options);
		const client = new Client(conn);
		client.send({ token });
		return client;
	}

	/** Send one line: a frame, or raw text when the line itself is the test. */
	send(frame: object | string): void {
		this.#conn.send(typeof frame === "string" ? frame : JSON.stringify(frame));
	}

	request(method: string, params: object = {}, id: number = this.#nextId++): Promise<Frame> {
		const pending = Promise.withResolvers<Frame>();
		this.#pending.set(id, pending);
		this.send({ id, method, params });
		return pending.promise;
	}

	destroy(): void {
		this.#conn.destroy();
	}
}

describe.skipIf(!PYTHON)("Binary Ninja worker transport", () => {
	let tmp: TempDir;
	let workers: Subprocess[];
	let clients: Client[];

	beforeEach(() => {
		tmp = TempDir.createSync("@omp-binja-transport-test-");
		workers = [];
		clients = [];
	});

	afterEach(async () => {
		for (const client of clients) client.destroy();
		for (const worker of workers) {
			if (worker.exitCode === null) worker.kill("SIGKILL");
			await worker.exited;
		}
		await tmp.remove();
	});

	/** Start the staged worker script on `listener`; resolves once it accepts connections. */
	async function startWorker(listener: Listener = "port-file") {
		if (!PYTHON) throw new Error("no Python 3 on PATH");
		const script = tmp.join("worker.py");
		await Bun.write(script, DISASM_BACKENDS.binja.workerScript);
		const target = tmp.join(listener === "socket" ? "worker.sock" : "port");
		const worker = Bun.spawn([PYTHON, script, listener === "socket" ? "--socket" : "--port-file", target], {
			env: {
				...process.env,
				PYTHONPATH: STUB,
				PYTHONUNBUFFERED: "1",
				PYTHONIOENCODING: "utf-8",
				OMP_DISASM_WORKER_TOKEN: TOKEN,
			},
			stdout: "ignore",
			stderr: Bun.file(tmp.join("worker.log")),
		});
		workers.push(worker);
		await waitFor(() => fs.existsSync(target), `the worker to listen on its ${listener}`);
		const endpoint = listener === "socket" ? target : Number(fs.readFileSync(target, "utf8"));
		// The file a new database is created from; the stub reads nothing out of it.
		const binary = tmp.join("sample");
		fs.writeFileSync(binary, "not a database");
		return { worker, endpoint, binary, database: `${binary}.bndb` };
	}

	async function connect(endpoint: number | string, token: string = TOKEN): Promise<Client> {
		const client = await Client.connect(endpoint, token);
		clients.push(client);
		return client;
	}

	/** Python that runs `body` after creating `marker`, so a test knows the request is running. */
	function announcing(marker: string, body: string): string {
		return `open(${JSON.stringify(marker)}, "w").close()\n${body}`;
	}

	for (const listener of LISTENERS) {
		it(
			`answers on its ${listener} listener only after the token, and answers every request it cannot run`,
			async () => {
				const { endpoint, binary, database } = await startWorker(listener);

				// The wrong token: closed unanswered.
				const stranger = await connect(endpoint, `${TOKEN}-wrong`);
				stranger.send({ id: 1, method: "status", params: {} });
				await stranger.closed;
				expect(stranger.unmatched).toEqual([]);

				const client = await connect(endpoint);
				expect(await client.request("status")).toEqual({ id: 1, ok: true, result: { open: false }, dirty: false });
				const opened = await client.request("open", { path: binary, new: true, binary });
				expect(opened).toMatchObject({ ok: true, result: { idb: database, format: "Stub" }, dirty: false });
				expect(fs.readFileSync(database, "utf8")).toBe(NEW_DATABASE);
				expect(await client.request("status")).toMatchObject({ ok: true, result: { open: true, idb: database } });

				expect(await client.request("nope")).toEqual({
					id: 4,
					ok: false,
					error: { type: "ValueError", message: "unknown method: nope" },
				});
				// A handler that raises, and a line that is not a request at all.
				expect(await client.request("view", { kind: "xrefs" })).toMatchObject({
					ok: false,
					error: { type: "ValueError", message: "view xrefs needs a target" },
				});
				client.send("not json");
				const malformed = await waitFor(() => client.unmatched[0], "the answer to a malformed line");
				expect(malformed).toMatchObject({ id: null, ok: false, error: { type: "JSONDecodeError" } });
				// None of that cost the connection.
				expect(await client.request("status")).toMatchObject({ ok: true, result: { open: true } });
			},
			TEST_TIMEOUT_MS,
		);
	}

	it(
		"keeps the database and the exec namespace when a new connection replaces the old one, and exits after close",
		async () => {
			const { worker, endpoint, binary, database } = await startWorker();
			const first = await connect(endpoint);
			await first.request("open", { path: binary, new: true, binary });
			expect((await first.request("exec", { code: "kept = 41" })).result).toMatchObject({ error: null });

			const second = await connect(endpoint);
			await first.closed;
			expect((await second.request("exec", { code: "kept + 1" })).result).toEqual({
				output: "",
				value: "42",
				error: null,
			});

			// Nothing is open after `close`, so the answer reports no unsaved changes.
			expect(await second.request("close", { save: false })).toMatchObject({
				ok: true,
				result: { closed: true, saved: false },
				dirty: false,
			});
			expect(await worker.exited).toBe(0);
			expect(fs.readFileSync(database, "utf8")).toBe(NEW_DATABASE);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"stops the running request on an interrupt frame, and cancels only the named request when the frame arrives first",
		async () => {
			const { endpoint, binary } = await startWorker();
			const client = await connect(endpoint);
			await client.request("open", { path: binary, new: true, binary });

			const running = tmp.join("running");
			const busy = client.request("exec", { code: announcing(running, "while True:\n    pass") }, 7);
			await waitFor(() => fs.existsSync(running), "the busy exec to start");
			client.send({ interrupt: 7 });
			expect((await busy).result).toEqual({ output: "", value: null, error: INTERRUPTED });

			// The frame for request 9 arrives before 8 and 9 do: 9 never starts, 8 and 10 are untouched.
			client.send({ interrupt: 9 });
			const eight = client.request("exec", { code: "'eight'" }, 8);
			const nine = client.request("exec", { code: "'nine'" }, 9);
			expect((await eight).result).toMatchObject({ value: "'eight'", error: null });
			expect(await nine).toEqual({ id: 9, ok: false, error: { type: "KeyboardInterrupt", message: "interrupted" } });
			expect((await client.request("exec", { code: "'ten'" }, 10)).result).toMatchObject({
				value: "'ten'",
				error: null,
			});
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"closes every undo span it opens: committed when the interrupt comes at the commit, reverted when it comes as the span opens or the code raises",
		async () => {
			const { endpoint, binary } = await startWorker();
			const client = await connect(endpoint);
			await client.request("open", { path: binary, new: true, binary });
			const exec = async (code: string) => (await client.request("exec", { code })).result;

			// Span 1: the interrupt is raised exactly when the worker commits, which is too late.
			const atCommit = [
				"import signal",
				"commit = bv.commit_undo_actions",
				"def interrupted_commit(span):",
				"    bv.commit_undo_actions = commit",
				"    signal.raise_signal(signal.SIGINT)",
				"    return commit(span)",
				"bv.commit_undo_actions = interrupted_commit",
				"'edited'",
			].join("\n");
			expect(await exec(atCommit)).toEqual({ output: "", value: "'edited'", error: null });

			// Span 2 arms the next one: span 3 is interrupted right after it opened.
			const atBegin = [
				"import signal",
				"begin = bv.begin_undo_actions",
				"def interrupted_begin():",
				"    bv.begin_undo_actions = begin",
				"    span = begin()",
				"    signal.raise_signal(signal.SIGINT)",
				"    return span",
				"bv.begin_undo_actions = interrupted_begin",
			].join("\n");
			expect(await exec(atBegin)).toMatchObject({ error: null });
			expect(await exec("'never runs'")).toEqual({ output: "", value: null, error: INTERRUPTED });

			// Span 4: the code raises after it printed.
			const raised = await exec("print('ran')\nraise RuntimeError('boom')");
			expect(raised).toMatchObject({ output: "ran\n", value: null });
			expect(raised?.error).toContain("RuntimeError: boom");

			// Span 5 reads the log: every earlier span was closed exactly once.
			expect(await exec("[entry for entry in bv.undo_log if entry[0] != 'begin']")).toMatchObject({
				value: "[('commit', 1), ('commit', 2), ('revert', 3), ('revert', 4)]",
			});
		},
		TEST_TIMEOUT_MS,
	);

	it.skipIf(process.platform === "win32")(
		"finishes the running request on SIGTERM, then saves and exits",
		async () => {
			const { worker, endpoint, binary, database } = await startWorker();
			const client = await connect(endpoint);
			await client.request("open", { path: binary, new: true, binary });

			const running = tmp.join("running");
			const slow = client.request("exec", {
				code: announcing(running, "import time\ntime.sleep(0.4)\n'finished'"),
			});
			await waitFor(() => fs.existsSync(running), "the slow exec to start");
			worker.kill("SIGTERM");
			expect((await slow).result).toMatchObject({ value: "'finished'", error: null });
			expect(await worker.exited).toBe(0);
			// An `exec` ran since the last save, so the close saved.
			expect(fs.readFileSync(database, "utf8")).toBe(NEW_DATABASE + SAVED);
		},
		TEST_TIMEOUT_MS,
	);
});
