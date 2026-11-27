/**
 * `omp --session-id <uuid>` resumes the session that holds an id the launcher chose, or starts a new
 * session under it. It refuses, before any model call, while another live omp process has that
 * session open; it refuses a value that is not a UUID (lowercasing one that is), and pairs with no
 * other session flag, nor with `--goal`.
 *
 * Every test takes its own id: the ownership leases are keyed by session id and shared by every bun
 * test process on the machine and the CLI processes they start, so a shared id would let two runs of
 * this file refuse each other.
 */
import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Effort } from "@oh-my-pi/pi-ai";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { applyExtensionFlags, type ExtensionFlagSink } from "@oh-my-pi/pi-coding-agent/cli/extension-flags";
import { restartArgv } from "@oh-my-pi/pi-coding-agent/cli/flag-tables";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { ScopedModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions, createSessionManager, SessionResolutionError } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { readSessionHeaderId } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	isSessionLeaseHeld,
	type SessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { cfgPrewalkEnabled } from "@oh-my-pi/pi-coding-agent/session/settings";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";

const cliEntry = path.resolve(import.meta.dir, "../../src/cli.ts");
const EARLIER = new Date("2026-11-01T10:00:00.000Z");
const settings = () => Settings.isolated({ "marketplace.autoUpdate": "off" });

/** A fresh session id for one test, in the form omp mints (lowercase UUID). */
function newSessionId(): string {
	return crypto.randomUUID();
}

/** The refusal a launch prints while another live omp process has session `id` open. */
function openElsewhere(id: string): string {
	return `Session "${id}" is open in another running omp process.`;
}

/** A stored session with one exchange, named the way the session manager names its files. */
async function storeSession(storage: SessionStorage, dir: string, id: string, cwd: string, at: Date): Promise<string> {
	storage.ensureDirSync(dir);
	const file = path.join(dir, `${at.toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`);
	const stamp = at.toISOString();
	const lines = [
		{ type: "session", version: 3, id, cwd, timestamp: stamp },
		{
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: stamp,
			message: { role: "user", content: "hello", timestamp: at.getTime() },
		},
		{
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp: stamp,
			message: { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: at.getTime() },
		},
	];
	await storage.writeText(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	return file;
}

/** The session files in `dir`, by name. */
async function sessionFiles(dir: string): Promise<string[]> {
	return (await fs.promises.readdir(dir)).filter(name => name.endsWith(".jsonl")).sort();
}

/** The `origin` field of the session header in `file` (the title slot may come first). */
async function headerOrigin(file: string): Promise<unknown> {
	for (const line of (await Bun.file(file).text()).split("\n")) {
		if (!line) continue;
		const record: unknown = JSON.parse(line);
		if (isRecord(record) && record.type === "session") return record.origin;
	}
	return undefined;
}

/** `--session-id <id>` parsed for a launch whose session directory is `dir`. */
function sessionIdArgs(dir: string, id: string) {
	const parsed = parseArgs(["--session-id", id]);
	parsed.sessionDir = dir;
	return parsed;
}

/**
 * Environment for a CLI launch whose home is `root`: the agent directory, `HOME` and the XDG roots
 * all point into it, so the launch writes nothing (presence records, logs, caches) under the
 * developer's real home.
 */
function launchEnv(root: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
	return {
		...process.env,
		HOME: root,
		PI_CODING_AGENT_DIR: path.join(root, "agent"),
		XDG_CONFIG_HOME: path.join(root, "config"),
		XDG_DATA_HOME: path.join(root, "data"),
		XDG_STATE_HOME: path.join(root, "state"),
		XDG_CACHE_HOME: path.join(root, "cache"),
		...extra,
	};
}

/**
 * Run the real CLI entry point with `sessionDir` as its session store and a home of its own (see
 * {@link launchEnv}). Pass `home` to share one home across launches, and `env` for extra variables.
 */
async function launch(
	args: string[],
	sessionDir: string,
	options: { home?: string; env?: Record<string, string> } = {},
): Promise<{ exitCode: number; stderr: string }> {
	using ownHome = TempDir.createSync("@omp-session-id-home-");
	const root = options.home ?? ownHome.path();
	const proc = Bun.spawn([process.execPath, cliEntry, "--no-extensions", "--session-dir", sessionDir, ...args], {
		cwd: sessionDir,
		env: launchEnv(root, options.env),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	return { exitCode, stderr };
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (isRecord(part) && "text" in part ? String(part.text) : "")).join("");
}

/** The user messages of a chat-completions request body, and whether it asked for a stream. */
function readChatRequest(body: unknown): { userMessages: string[]; stream: boolean } {
	if (!isRecord(body)) return { userMessages: [], stream: false };
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const userMessages = messages.flatMap(message =>
		isRecord(message) && message.role === "user" ? [messageText(message.content)] : [],
	);
	return { userMessages, stream: body.stream === true };
}

/**
 * An OpenAI-compatible model for CLI launches whose agent directory is `agentDir` (model
 * `fake/fake-model`): it answers `pong`, and keeps the user messages of every request it gets.
 */
async function startModel(agentDir: string): Promise<{ requests: string[][]; [Symbol.dispose](): void }> {
	const requests: string[][] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname.endsWith("/models")) {
				return Response.json({ object: "list", data: [{ id: "fake-model", object: "model", owned_by: "fake" }] });
			}
			if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
			const body: unknown = await request.json();
			const { userMessages, stream } = readChatRequest(body);
			requests.push(userMessages);
			const base = { id: "chatcmpl-fake", created: 0, model: "fake-model" };
			const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
			if (!stream) {
				return Response.json({
					...base,
					object: "chat.completion",
					choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
					usage,
				});
			}
			const chunk = { ...base, object: "chat.completion.chunk" };
			const events = [
				{ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: null }] },
				{ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
				{ ...chunk, choices: [], usage },
			].map(event => `data: ${JSON.stringify(event)}\n\n`);
			return new Response(`${events.join("")}data: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	await Bun.write(
		path.join(agentDir, "models.yml"),
		[
			"providers:",
			"  fake:",
			`    baseUrl: http://127.0.0.1:${server.port}/v1`,
			"    auth: none",
			"    api: openai-completions",
			"    models:",
			"      - id: fake-model",
			"        name: Fake Model",
			"        reasoning: false",
			"",
		].join("\n"),
	);
	return { requests, [Symbol.dispose]: () => server.stop(true) };
}

/** Every file under `dir` whose name is `name`, at any depth. */
async function findFiles(dir: string, name: string): Promise<string[]> {
	return (await fs.promises.readdir(dir, { recursive: true, withFileTypes: true }))
		.filter(entry => entry.isFile() && entry.name === name)
		.map(entry => path.join(entry.parentPath, entry.name));
}

/** `run` with `name` set to `value` in the environment, restored afterwards. */
async function withEnv<T>(name: string, value: string, run: () => Promise<T>): Promise<T> {
	const previous = process.env[name];
	process.env[name] = value;
	try {
		return await run();
	} finally {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	}
}

/** What `run` returned or threw; a returned session manager is closed. */
async function outcomeOf(run: () => Promise<SessionManager | undefined>): Promise<unknown> {
	try {
		const manager = await run();
		await manager?.close();
		return manager;
	} catch (error) {
		return error;
	}
}

/**
 * An ownership-lease directory the lease code refuses (another user could enter it), so taking a
 * lease fails for a reason other than another process holding it. Tests point
 * `PI_TEST_SESSION_OWNERS_DIR` at it.
 */
async function unusableOwnersDir(root: string): Promise<string> {
	const dir = path.join(root, "owners");
	await fs.promises.mkdir(dir, { mode: 0o755 });
	await fs.promises.chmod(dir, 0o755);
	return dir;
}

describe("omp --session-id", () => {
	it("starts a new session under the given id", async () => {
		const id = newSessionId();
		using dir = TempDir.createSync("@omp-session-id-new-");
		const manager = await createSessionManager(sessionIdArgs(dir.path(), id), dir.path(), settings());
		if (!manager) throw new Error("--session-id selected no session: the flag was not applied");
		try {
			expect(manager.getHeader()?.id, "the new session's header id").toBe(id);
			const file = manager.getSessionFile();
			if (!file) throw new Error("the new session has no file");
			expect(path.basename(file)).toEndWith(`_${id}.jsonl`);
			// The header is written at once, so a later launch under the id finds the session.
			expect(await readSessionHeaderId(file), "the header written to the session file").toBe(id);
		} finally {
			await manager.close();
		}
	});

	it("resumes the stored session that holds the id, with its turns", async () => {
		const id = newSessionId();
		using dir = TempDir.createSync("@omp-session-id-resume-");
		const stored = await storeSession(new FileSessionStorage(), dir.path(), id, dir.path(), EARLIER);
		const manager = await createSessionManager(sessionIdArgs(dir.path(), id), dir.path(), settings());
		if (!manager) throw new Error("--session-id selected no session");
		try {
			expect(manager.getSessionId()).toBe(id);
			expect(manager.getSessionFile()).toBe(stored);
			expect(manager.getEntries().map(entry => entry.id)).toEqual(["m1", "m2"]);
			expect(await sessionFiles(dir.path()), "no new session file").toEqual([path.basename(stored)]);
		} finally {
			await manager.close();
		}
	});

	it("starts a new session when the only stored session's id merely starts with the id", async () => {
		const id = newSessionId();
		using dir = TempDir.createSync("@omp-session-id-extends-");
		const other = await storeSession(new FileSessionStorage(), dir.path(), `${id}-later`, dir.path(), EARLIER);
		const manager = await createSessionManager(sessionIdArgs(dir.path(), id), dir.path(), settings());
		if (!manager) throw new Error("--session-id selected no session");
		try {
			expect(manager.getSessionId()).toBe(id);
			expect(manager.getSessionFile()).not.toBe(other);
			expect(manager.getEntries()).toEqual([]);
			expect(await sessionFiles(dir.path())).toHaveLength(2);
		} finally {
			await manager.close();
		}
	});

	it("resumes a session it started for another client, instead of writing a second one under the id", async () => {
		const id = newSessionId();
		using dir = TempDir.createSync("@omp-session-id-origin-");
		// The Chrome extension's native host sets PI_SESSION_ORIGIN; the terminal's listings skip such sessions.
		await withEnv("PI_SESSION_ORIGIN", "chrome", async () => {
			const first = await createSessionManager(sessionIdArgs(dir.path(), id), dir.path(), settings());
			const file = first?.getSessionFile();
			await first?.close();
			if (!file) throw new Error("the first launch wrote no session file");
			expect(await headerOrigin(file), "the session carries the client's origin").toBe("chrome");

			const second = await createSessionManager(sessionIdArgs(dir.path(), id), dir.path(), settings());
			try {
				expect(second?.getSessionFile(), "the second launch resumed the first session").toBe(file);
				expect(await sessionFiles(dir.path()), "one session file under the id").toEqual([path.basename(file)]);
			} finally {
				await second?.close();
			}
		});
	});

	it("starts a resumed session on its own model with no prewalk, and a new one on the startup defaults", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5 to be bundled");
		using dir = TempDir.createSync("@omp-session-id-startup-");
		const authStorage = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		try {
			const modelRegistry = new ModelRegistry(authStorage, path.join(dir.path(), "models.yml"));
			const startupSettings = settings();
			cfgPrewalkEnabled.set(startupSettings, true);
			startupSettings.setModelRole("smol", `${model.provider}/${model.id}`);
			authStorage.keys.setRuntime(model.provider, "test-key");
			const scoped: ScopedModel[] = [{ model, thinkingLevel: Effort.High, explicitThinkingLevel: true }];
			const sessions = path.join(dir.path(), "sessions");
			const startup = async (id: string) => {
				const parsed = sessionIdArgs(sessions, id);
				const manager = await createSessionManager(parsed, dir.path(), startupSettings);
				try {
					return await buildSessionOptions(parsed, scoped, manager, modelRegistry, startupSettings, () => {});
				} finally {
					await manager?.close();
				}
			};

			// A new session under the id is a fresh launch: the configured prewalk and the scoped model apply.
			const fresh = await startup(newSessionId());
			expect(fresh.prewalk?.target.id, "a new session arms the configured prewalk").toBe(model.id);
			expect(fresh.model?.id, "a new session starts on the scoped model").toBe(model.id);
			expect(fresh.thinkingLevel, "a new session takes the scope's thinking level").toBe(Effort.High);

			const id = newSessionId();
			await storeSession(new FileSessionStorage(), sessions, id, dir.path(), EARLIER);
			const resumed = await startup(id);
			expect(resumed.prewalk, "a resumed session arms no implicit prewalk").toBeUndefined();
			expect(resumed.model, "a resumed session keeps its own model").toBeUndefined();
			expect(resumed.thinkingLevel, "a resumed session keeps its own thinking level").toBeUndefined();
		} finally {
			authStorage.close();
		}
	});

	it.skipIf(process.platform === "win32")(
		"exits when the user declines to move the stored session, starting no other session",
		async () => {
			const id = newSessionId();
			using home = TempDir.createSync("@omp-session-id-move-home-");
			using root = TempDir.createSync("@omp-session-id-move-");
			const sessions = path.join(root.path(), "sessions");
			const project = path.join(root.path(), "project");
			await fs.promises.mkdir(project);
			// Recorded in a directory that no longer exists, so opening it offers to move it here.
			const stored = await storeSession(
				new FileSessionStorage(),
				sessions,
				id,
				path.join(root.path(), "gone"),
				EARLIER,
			);
			const before = await Bun.file(stored).text();

			const decoder = new TextDecoder();
			const prompted = Promise.withResolvers<void>();
			const closed = Promise.withResolvers<void>();
			let output = "";
			await using terminal = new Bun.Terminal({
				cols: 200,
				rows: 50,
				data(_terminal, data) {
					output += decoder.decode(data, { stream: true });
					if (output.includes("Move (re-root) it into the current directory?")) prompted.resolve();
				},
				exit() {
					closed.resolve();
				},
			});
			const proc = Bun.spawn(
				[
					process.execPath,
					cliEntry,
					"--no-extensions",
					"--session-dir",
					sessions,
					"--session-id",
					id,
					"-p",
					"hello",
				],
				{ cwd: project, env: launchEnv(home.path()), terminal, signal: AbortSignal.timeout(30_000) },
			);
			try {
				await Promise.race([
					prompted.promise,
					proc.exited.then(code => {
						throw new Error(`the launch exited before it asked to move the session (exit ${code}): ${output}`);
					}),
				]);
				terminal.write("n\r");
				expect(await proc.exited, output).toBe(0);
				expect(output).toContain("Resume cancelled: session was not moved.");
				expect(await sessionFiles(sessions), "no other session was started").toEqual([path.basename(stored)]);
				expect(await Bun.file(stored).text(), "the stored session is unchanged").toBe(before);
			} finally {
				if (proc.exitCode === null) proc.kill();
				await proc.exited;
				terminal.close();
				await closed.promise;
			}
		},
		45_000,
	);

	it("refuses to create a session under the id when its ownership lease cannot be taken", async () => {
		const id = newSessionId();
		using dir = TempDir.createSync("@omp-session-id-lease-new-");
		const owners = await unusableOwnersDir(dir.path());
		const sessions = path.join(dir.path(), "sessions");
		const outcome = await withEnv("PI_TEST_SESSION_OWNERS_DIR", owners, () =>
			outcomeOf(() => createSessionManager(sessionIdArgs(sessions, id), dir.path(), settings())),
		);
		expect(outcome, "the launch was refused").toBeInstanceOf(SessionResolutionError);
		expect(outcome instanceof Error ? outcome.message : "").toContain(
			`The ownership lease of session "${id}" is unavailable`,
		);
		expect(await sessionFiles(sessions), "no session file was written").toEqual([]);
	});

	it("refuses to resume the stored session when its ownership lease cannot be taken", async () => {
		const id = newSessionId();
		using dir = TempDir.createSync("@omp-session-id-lease-stored-");
		const owners = await unusableOwnersDir(dir.path());
		const sessions = path.join(dir.path(), "sessions");
		const stored = await storeSession(new FileSessionStorage(), sessions, id, dir.path(), EARLIER);
		const before = await Bun.file(stored).text();
		const outcome = await withEnv("PI_TEST_SESSION_OWNERS_DIR", owners, () =>
			outcomeOf(() => createSessionManager(sessionIdArgs(sessions, id), dir.path(), settings())),
		);
		expect(outcome, "the launch was refused").toBeInstanceOf(SessionResolutionError);
		expect(outcome instanceof Error ? outcome.message : "").toContain(
			`The ownership lease of session "${id}" is unavailable`,
		);
		expect(await Bun.file(stored).text(), "the stored session is unchanged").toBe(before);
	});

	it("gives the id's lease up when creating the session fails", async () => {
		using dir = TempDir.createSync("@omp-session-id-failed-");
		// The store lookup after the claim rejects.
		const lookupFailed = newSessionId();
		const failure = new Error("session store unreadable");
		const rejected = await SessionManager.createWithSessionId(dir.path(), dir.path(), lookupFailed, async () => {
			throw failure;
		}).catch((error: unknown) => error);
		expect(rejected, "the lookup's own failure").toBe(failure);
		expect(isSessionLeaseHeld(lookupFailed), "no process holds the id's lease").toBe(false);

		// The header write fails: the session directory became a file.
		const writeFailed = newSessionId();
		const sessions = path.join(dir.path(), "sessions");
		const thrown = await SessionManager.createWithSessionId(dir.path(), sessions, writeFailed, async () => {
			await fs.promises.rm(sessions, { recursive: true, force: true });
			await Bun.write(sessions, "not a directory");
			return false;
		}).catch((error: unknown) => error);
		expect(thrown, "the header write failed").toBeInstanceOf(Error);
		expect(isSessionLeaseHeld(writeFailed), "no process holds the id's lease").toBe(false);
	});

	it("refuses, writing nothing, when the stored session is removed while it opens", async () => {
		const id = newSessionId();
		using dir = TempDir.createSync("@omp-session-id-removed-");
		const stored = await storeSession(new FileSessionStorage(), dir.path(), id, dir.path(), EARLIER);
		// The transcript disappears after the lookup found it and before the claim and the open.
		const claimStoredSession = SessionManager.claimStoredSession.bind(SessionManager);
		const claimed: Array<[string, string]> = [];
		const claim = spyOn(SessionManager, "claimStoredSession").mockImplementation((sessionPath, sessionId) => {
			claimed.push([sessionPath, sessionId]);
			fs.unlinkSync(sessionPath);
			return claimStoredSession(sessionPath, sessionId);
		});
		let outcome: unknown;
		try {
			outcome = await outcomeOf(() => createSessionManager(sessionIdArgs(dir.path(), id), dir.path(), settings()));
		} finally {
			claim.mockRestore();
		}
		expect(claimed, "the lookup found the stored session").toEqual([[stored, id]]);
		expect(outcome, "the launch was refused").toBeInstanceOf(SessionResolutionError);
		expect(outcome instanceof Error ? outcome.message : "").toContain(
			`Session "${id}" was removed while omp opened it.`,
		);
		expect(await sessionFiles(dir.path()), "no session was written at its path or beside it").toEqual([]);
	});

	it("resumes the session on a later launch, so the model sees the earlier turn", async () => {
		const id = newSessionId();
		using home = TempDir.createSync("@omp-session-id-model-home-");
		using dir = TempDir.createSync("@omp-session-id-model-");
		using model = await startModel(path.join(home.path(), "agent"));
		const run = (prompt: string) =>
			launch(["--session-id", id, "--model", "fake/fake-model", "-p", prompt], dir.path(), {
				home: home.path(),
				env: { PI_NO_TITLE: "1" },
			});

		const first = await run("Remember the word pineapple.");
		expect(first.exitCode, first.stderr).toBe(0);
		const [file] = await sessionFiles(dir.path());
		if (!file) throw new Error("the first launch wrote no session file");
		expect(await readSessionHeaderId(path.join(dir.path(), file))).toBe(id);

		const second = await run("Which word did I ask you to remember?");
		expect(second.exitCode, second.stderr).toBe(0);
		expect(await sessionFiles(dir.path()), "the second launch wrote to the same session").toEqual([file]);
		const resumed = model.requests.find(request => request.some(text => text.includes("Which word did I ask")));
		if (!resumed) throw new Error(`no model request carried the second prompt: ${JSON.stringify(model.requests)}`);
		expect(
			resumed.some(text => text.includes("Remember the word pineapple.")),
			"the second launch's request carries the first turn",
		).toBe(true);
	}, 60_000);

	it("refuses an id another live process owns while creating the session, before it writes anything", async () => {
		const id = newSessionId();
		using dir = TempDir.createSync("@omp-session-id-claimed-");
		let refused: { exitCode: number; stderr: string; files: string[] } | undefined;
		// This test process plays the first launch. While it checks the store it owns the id and has
		// written nothing; a second launch under the id runs in that window.
		const creation = await SessionManager.createWithSessionId(dir.path(), dir.path(), id, async () => {
			const result = await launch(["--session-id", id, "-p", "hello"], dir.path());
			refused = { ...result, files: await fs.promises.readdir(dir.path()) };
			return false;
		});
		const owner = creation.status === "created" ? creation.manager : undefined;
		try {
			expect(owner?.getSessionId(), "the first launch got the id").toBe(id);
			expect(refused?.exitCode, refused?.stderr).toBe(1);
			expect(refused?.stderr).toContain(openElsewhere(id));
			expect(refused?.files, "nothing was written while the second launch ran").toEqual([]);
		} finally {
			await owner?.close();
		}
	}, 30_000);

	it("refuses to resume a session another live process has open, and leaves its file alone", async () => {
		const id = newSessionId();
		using dir = TempDir.createSync("@omp-session-id-open-");
		const owner = await createSessionManager(sessionIdArgs(dir.path(), id), dir.path(), settings());
		if (!owner) throw new Error("--session-id selected no session");
		try {
			const [file] = await sessionFiles(dir.path());
			if (!file) throw new Error("the owner wrote no session file");
			const before = await Bun.file(path.join(dir.path(), file)).text();

			const result = await launch(["--session-id", id, "-p", "hello"], dir.path());

			expect(result.exitCode, result.stderr).toBe(1);
			expect(result.stderr).toContain(openElsewhere(id));
			expect(await sessionFiles(dir.path()), "no sibling session was written").toEqual([file]);
			expect(await Bun.file(path.join(dir.path(), file)).text(), "the owner's file is unchanged").toBe(before);
		} finally {
			await owner.close();
		}
	}, 30_000);

	it("leaves the terminal's last-session record alone when it refuses an id", async () => {
		const id = newSessionId();
		using home = TempDir.createSync("@omp-session-id-terminal-");
		using dir = TempDir.createSync("@omp-session-id-crumb-");
		// Zellij's pane outranks tmux's in the terminal identity, so an inherited one is cleared.
		const terminal = { ZELLIJ_PANE_ID: "", ZELLIJ_SESSION_NAME: "", TMUX_PANE: "%e0-session-id" };
		// A first launch in this terminal records its session (the run itself stops at model selection).
		await launch(["--session-id", newSessionId(), "-p", "hello"], dir.path(), {
			home: home.path(),
			env: terminal,
		});
		const [crumb] = await findFiles(home.path(), "tmux-%e0-session-id");
		if (!crumb) throw new Error("the first launch recorded no terminal breadcrumb");
		const before = await Bun.file(crumb).text();

		const owner = await createSessionManager(sessionIdArgs(dir.path(), id), dir.path(), settings());
		try {
			const refused = await launch(["--session-id", id, "-p", "hello"], dir.path(), {
				home: home.path(),
				env: terminal,
			});
			expect(refused.exitCode, refused.stderr).toBe(1);
			expect(refused.stderr).toContain(openElsewhere(id));
			expect(await Bun.file(crumb).text(), "the refused launch did not replace the terminal's record").toBe(before);
		} finally {
			await owner?.close();
		}
	}, 30_000);

	it("refuses a value that is no UUID", async () => {
		// Malformed, empty.
		for (const value of ["not-a-uuid", ""]) {
			expect(() => parseArgs(["--session-id", value]), JSON.stringify(value)).toThrow(
				`Invalid --session-id value: ${JSON.stringify(value)}. Expected a UUID.`,
			);
		}
		// omp mints lowercase ids; an uppercase UUID (macOS `uuidgen`) names the same session.
		const id = newSessionId();
		expect(parseArgs(["--session-id", id.toUpperCase()]).sessionId).toBe(id);

		using dir = TempDir.createSync("@omp-session-id-invalid-");
		const result = await launch(["--session-id", "not-a-uuid", "-p", "hello"], dir.path());
		expect(result.exitCode, result.stderr).toBe(2);
		expect(result.stderr).toContain('Invalid --session-id value: "not-a-uuid". Expected a UUID.');
		expect(await fs.promises.readdir(dir.path())).toEqual([]);
	}, 30_000);

	it("refuses an invalid value before another session flag acts", async () => {
		using dir = TempDir.createSync("@omp-session-id-invalid-fork-");
		const source = await storeSession(new FileSessionStorage(), dir.path(), newSessionId(), dir.path(), EARLIER);
		const before = (await fs.promises.readdir(dir.path())).sort();
		const result = await launch(["--session-id", "not-a-uuid", "--fork", source, "-p", "hello"], dir.path());
		expect(result.exitCode, result.stderr).toBe(2);
		expect(result.stderr).toContain('Invalid --session-id value: "not-a-uuid". Expected a UUID.');
		expect((await fs.promises.readdir(dir.path())).sort(), "the fork wrote no session").toEqual(before);
	}, 30_000);

	it("keeps --session-id the built-in flag when an extension registers a flag of that name", () => {
		const id = newSessionId();
		const extensionFlags = new Map<string, { type: "boolean" | "string" }>([["session-id", { type: "string" }]]);
		const received: Array<[string, boolean | string]> = [];
		const sink: ExtensionFlagSink = {
			getFlags: () => extensionFlags,
			setFlagValue: (name, value) => {
				received.push([name, value]);
			},
		};
		// The extension-aware reparse reads the flag as the startup parse did, which already acted on it.
		const parsed = applyExtensionFlags(sink, ["--session-id", id, "hello"]);
		expect(parsed?.sessionId, "the built-in flag holds the id").toBe(id);
		expect(parsed?.messages, "the id is not taken as the prompt").toEqual(["hello"]);
		expect(received, "the extension's flag got no value").toEqual([]);
		// A value that is no UUID is the same usage error in both parses.
		expect(() => applyExtensionFlags(sink, ["--session-id", "not-a-uuid"])).toThrow(
			'Invalid --session-id value: "not-a-uuid". Expected a UUID.',
		);
	});

	it("refuses the flag with no value instead of starting a session under a minted id", async () => {
		expect(() => parseArgs(["-p", "hello", "--session-id"])).toThrow("--session-id requires a UUID.");

		using dir = TempDir.createSync("@omp-session-id-missing-");
		const result = await launch(["-p", "hello", "--session-id"], dir.path());
		expect(result.exitCode, result.stderr).toBe(2);
		expect(result.stderr).toContain("--session-id requires a UUID.");
		expect(await fs.promises.readdir(dir.path()), "no session file was written").toEqual([]);
	}, 30_000);

	it("refuses --session-id with --resume, --continue, --fork, --no-session, --goal and ACP mode", async () => {
		const id = newSessionId();
		using dir = TempDir.createSync("@omp-session-id-pairs-");
		const other = await storeSession(new FileSessionStorage(), dir.path(), `${id}-later`, dir.path(), EARLIER);
		const before = (await fs.promises.readdir(dir.path())).sort();
		// One row per option `--session-id` refuses; `-r`/`--session` and `-c` parse to `--resume` and `--continue`.
		// ACP mode starts a session per client request, so the id would name none of them.
		const shapes: Array<{ args: string[]; names: string }> = [
			{ args: ["--resume", other], names: "--resume" },
			{ args: ["--restore", other], names: "--restore" },
			{ args: ["--continue"], names: "--continue" },
			{ args: ["--fork", other], names: "--fork" },
			{ args: ["--no-session"], names: "--no-session" },
			{ args: ["--from-claude"], names: "--from-claude" },
			{ args: ["--from-codex"], names: "--from-codex" },
			{ args: ["--mode", "acp"], names: "--mode acp" },
			// A goal needs a fresh session, and the id can name a stored one.
			{ args: ["--goal", "ship it"], names: "--goal" },
		];
		for (const shape of shapes) {
			const label = shape.args.join(" ");
			const result = await launch(["--session-id", id, ...shape.args, "-p", "hello"], dir.path());
			expect(result.exitCode, `${label}: ${result.stderr}`).toBe(2);
			expect(result.stderr, label).toContain(`--session-id cannot be combined with ${shape.names}`);
			expect((await fs.promises.readdir(dir.path())).sort(), label).toEqual(before);
		}
	}, 120_000);

	it("is dropped from a relaunch, which restores the session instead", () => {
		const id = newSessionId();
		expect(restartArgv(["--session-id", id, "--model", "m"], id)).toEqual(["--model", "m", "--restore", id]);
	});
});
