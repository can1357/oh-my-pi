/**
 * `omp --session-id <uuid>` resumes the session that holds an id the launcher chose, or starts a new
 * session under it. It refuses, before any model call, while another live omp process has that
 * session open; it refuses a value that is not a UUID (lowercasing one that is), and pairs with no
 * other session flag, nor with `--goal`.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { restartArgv } from "@oh-my-pi/pi-coding-agent/cli/flag-tables";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { readSessionHeaderId } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type SessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const cliEntry = path.resolve(import.meta.dir, "../../src/cli.ts");
const SESSION_ID = "019ea530-5e55-7000-8000-00000000c0de";
/** An id that starts with {@link SESSION_ID}: a prefix lookup for that id also matches it. */
const LONGER_ID = `${SESSION_ID}-later`;
/** A second, unrelated session id. */
const OTHER_ID = "019ea530-5e55-7000-8000-00000000beef";
const EARLIER = new Date("2026-11-01T10:00:00.000Z");
const OPEN_ELSEWHERE = `Session "${SESSION_ID}" is open in another running omp process.`;
const settings = () => Settings.isolated({ "marketplace.autoUpdate": "off" });

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
function sessionFiles(dir: string): string[] {
	return fs
		.readdirSync(dir)
		.filter(name => name.endsWith(".jsonl"))
		.sort();
}

/** `--session-id <id>` parsed for a launch whose session directory is `dir`. */
function sessionIdArgs(dir: string, id = SESSION_ID) {
	const parsed = parseArgs(["--session-id", id]);
	parsed.sessionDir = dir;
	return parsed;
}

/**
 * Run the real CLI entry point with `sessionDir` as its session store and a home of its own: the agent
 * directory, `HOME` and the XDG roots all point into one temporary directory, so the launch writes
 * nothing (presence records, logs, caches) under the developer's real home. Pass `home` to share one
 * home across launches, and `env` for extra variables.
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
		env: {
			...process.env,
			HOME: root,
			PI_CODING_AGENT_DIR: path.join(root, "agent"),
			XDG_CONFIG_HOME: path.join(root, "config"),
			XDG_DATA_HOME: path.join(root, "data"),
			XDG_STATE_HOME: path.join(root, "state"),
			XDG_CACHE_HOME: path.join(root, "cache"),
			...options.env,
		},
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
	return content
		.map(part => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
		.join("");
}

/**
 * An OpenAI-compatible model for CLI launches whose agent directory is `agentDir` (model
 * `fake/fake-model`): it answers `pong`, and keeps the user messages of every request it gets.
 */
function startModel(agentDir: string): { requests: string[][]; [Symbol.dispose](): void } {
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
			const body = (await request.json()) as {
				messages?: Array<{ role?: string; content?: unknown }>;
				stream?: boolean;
			};
			requests.push((body.messages ?? []).filter(m => m.role === "user").map(m => messageText(m.content)));
			const base = { id: "chatcmpl-fake", created: 0, model: "fake-model" };
			const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
			if (!body.stream) {
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
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(
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
function findFiles(dir: string, name: string): string[] {
	return fs
		.readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter(entry => entry.isFile() && entry.name === name)
		.map(entry => path.join(entry.parentPath, entry.name));
}

describe("omp --session-id", () => {
	it("starts a new session under the given id", async () => {
		using dir = TempDir.createSync("@omp-session-id-new-");
		const manager = await createSessionManager(sessionIdArgs(dir.path()), dir.path(), settings());
		if (!manager) throw new Error("--session-id selected no session: the flag was not applied");
		try {
			expect(manager.getHeader()?.id, "the new session's header id").toBe(SESSION_ID);
			const file = manager.getSessionFile();
			if (!file) throw new Error("the new session has no file");
			expect(path.basename(file)).toEndWith(`_${SESSION_ID}.jsonl`);
			// The header is written at once, so a later launch under the id finds the session.
			expect(await readSessionHeaderId(file), "the header written to the session file").toBe(SESSION_ID);
		} finally {
			await manager.close();
		}
	});

	it("resumes the stored session that holds the id, with its turns", async () => {
		using dir = TempDir.createSync("@omp-session-id-resume-");
		const stored = await storeSession(new FileSessionStorage(), dir.path(), SESSION_ID, dir.path(), EARLIER);
		const manager = await createSessionManager(sessionIdArgs(dir.path()), dir.path(), settings());
		if (!manager) throw new Error("--session-id selected no session");
		try {
			expect(manager.getSessionId()).toBe(SESSION_ID);
			expect(manager.getSessionFile()).toBe(stored);
			expect(manager.getEntries().map(entry => entry.id)).toEqual(["m1", "m2"]);
			expect(sessionFiles(dir.path()), "no new session file").toEqual([path.basename(stored)]);
		} finally {
			await manager.close();
		}
	});

	it("starts a new session when the only stored session's id merely starts with the id", async () => {
		using dir = TempDir.createSync("@omp-session-id-extends-");
		const other = await storeSession(new FileSessionStorage(), dir.path(), LONGER_ID, dir.path(), EARLIER);
		const manager = await createSessionManager(sessionIdArgs(dir.path()), dir.path(), settings());
		if (!manager) throw new Error("--session-id selected no session");
		try {
			expect(manager.getSessionId()).toBe(SESSION_ID);
			expect(manager.getSessionFile()).not.toBe(other);
			expect(manager.getEntries()).toEqual([]);
			expect(sessionFiles(dir.path())).toHaveLength(2);
		} finally {
			await manager.close();
		}
	});

	it("resumes the session on a later launch, so the model sees the earlier turn", async () => {
		using home = TempDir.createSync("@omp-session-id-model-home-");
		using dir = TempDir.createSync("@omp-session-id-model-");
		using model = startModel(path.join(home.path(), "agent"));
		const run = (prompt: string) =>
			launch(["--session-id", SESSION_ID, "--model", "fake/fake-model", "-p", prompt], dir.path(), {
				home: home.path(),
				env: { PI_NO_TITLE: "1" },
			});

		const first = await run("Remember the word pineapple.");
		expect(first.exitCode, first.stderr).toBe(0);
		const [file] = sessionFiles(dir.path());
		if (!file) throw new Error("the first launch wrote no session file");
		expect(await readSessionHeaderId(path.join(dir.path(), file))).toBe(SESSION_ID);

		const second = await run("Which word did I ask you to remember?");
		expect(second.exitCode, second.stderr).toBe(0);
		expect(sessionFiles(dir.path()), "the second launch wrote to the same session").toEqual([file]);
		const resumed = model.requests.find(request => request.some(text => text.includes("Which word did I ask")));
		if (!resumed) throw new Error(`no model request carried the second prompt: ${JSON.stringify(model.requests)}`);
		expect(
			resumed.some(text => text.includes("Remember the word pineapple.")),
			"the second launch's request carries the first turn",
		).toBe(true);
	}, 60_000);

	it("refuses an id another live process owns while creating the session, before it writes anything", async () => {
		using dir = TempDir.createSync("@omp-session-id-claimed-");
		let refused: { exitCode: number; stderr: string; files: string[] } | undefined;
		// This test process plays the first launch. While it checks the store it owns the id and has
		// written nothing; a second launch under the id runs in that window.
		const creation = await SessionManager.createWithSessionId(dir.path(), dir.path(), SESSION_ID, async () => {
			const result = await launch(["--session-id", SESSION_ID, "-p", "hello"], dir.path());
			refused = { ...result, files: fs.readdirSync(dir.path()) };
			return false;
		});
		const owner = creation.status === "created" ? creation.manager : undefined;
		try {
			expect(owner?.getSessionId(), "the first launch got the id").toBe(SESSION_ID);
			expect(refused?.exitCode, refused?.stderr).toBe(1);
			expect(refused?.stderr).toContain(OPEN_ELSEWHERE);
			expect(refused?.files, "nothing was written while the second launch ran").toEqual([]);
		} finally {
			await owner?.close();
		}
	}, 30_000);

	it("refuses to resume a session another live process has open, and leaves its file alone", async () => {
		using dir = TempDir.createSync("@omp-session-id-open-");
		const owner = await createSessionManager(sessionIdArgs(dir.path()), dir.path(), settings());
		if (!owner) throw new Error("--session-id selected no session");
		try {
			const [file] = sessionFiles(dir.path());
			if (!file) throw new Error("the owner wrote no session file");
			const before = fs.readFileSync(path.join(dir.path(), file), "utf8");

			const result = await launch(["--session-id", SESSION_ID, "-p", "hello"], dir.path());

			expect(result.exitCode, result.stderr).toBe(1);
			expect(result.stderr).toContain(OPEN_ELSEWHERE);
			expect(sessionFiles(dir.path()), "no sibling session was written").toEqual([file]);
			expect(fs.readFileSync(path.join(dir.path(), file), "utf8"), "the owner's file is unchanged").toBe(before);
		} finally {
			await owner.close();
		}
	}, 30_000);

	it("leaves the terminal's last-session record alone when it refuses an id", async () => {
		using home = TempDir.createSync("@omp-session-id-terminal-");
		using dir = TempDir.createSync("@omp-session-id-crumb-");
		// Zellij's pane outranks tmux's in the terminal identity, so an inherited one is cleared.
		const terminal = { ZELLIJ_PANE_ID: "", ZELLIJ_SESSION_NAME: "", TMUX_PANE: "%e0-session-id" };
		// A first launch in this terminal records its session (the run itself stops at model selection).
		await launch(["--session-id", OTHER_ID, "-p", "hello"], dir.path(), {
			home: home.path(),
			env: terminal,
		});
		const [crumb] = findFiles(home.path(), "tmux-%e0-session-id");
		if (!crumb) throw new Error("the first launch recorded no terminal breadcrumb");
		const before = fs.readFileSync(crumb, "utf8");

		const owner = await createSessionManager(sessionIdArgs(dir.path()), dir.path(), settings());
		try {
			const refused = await launch(["--session-id", SESSION_ID, "-p", "hello"], dir.path(), {
				home: home.path(),
				env: terminal,
			});
			expect(refused.exitCode, refused.stderr).toBe(1);
			expect(refused.stderr).toContain(OPEN_ELSEWHERE);
			expect(fs.readFileSync(crumb, "utf8"), "the refused launch did not replace the terminal's record").toBe(
				before,
			);
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
		expect(parseArgs(["--session-id", SESSION_ID.toUpperCase()]).sessionId).toBe(SESSION_ID);

		using dir = TempDir.createSync("@omp-session-id-invalid-");
		const result = await launch(["--session-id", "not-a-uuid", "-p", "hello"], dir.path());
		expect(result.exitCode, result.stderr).toBe(2);
		expect(result.stderr).toContain('Invalid --session-id value: "not-a-uuid". Expected a UUID.');
		expect(fs.readdirSync(dir.path())).toEqual([]);
	}, 30_000);

	it("refuses an invalid value before another session flag acts", async () => {
		using dir = TempDir.createSync("@omp-session-id-invalid-fork-");
		const source = await storeSession(new FileSessionStorage(), dir.path(), LONGER_ID, dir.path(), EARLIER);
		const before = fs.readdirSync(dir.path()).sort();
		const result = await launch(["--session-id", "not-a-uuid", "--fork", source, "-p", "hello"], dir.path());
		expect(result.exitCode, result.stderr).toBe(2);
		expect(result.stderr).toContain('Invalid --session-id value: "not-a-uuid". Expected a UUID.');
		expect(fs.readdirSync(dir.path()).sort(), "the fork wrote no session").toEqual(before);
	}, 30_000);

	it("refuses the flag with no value instead of starting a session under a minted id", async () => {
		expect(() => parseArgs(["-p", "hello", "--session-id"])).toThrow("--session-id requires a UUID.");

		using dir = TempDir.createSync("@omp-session-id-missing-");
		const result = await launch(["-p", "hello", "--session-id"], dir.path());
		expect(result.exitCode, result.stderr).toBe(2);
		expect(result.stderr).toContain("--session-id requires a UUID.");
		expect(fs.readdirSync(dir.path()), "no session file was written").toEqual([]);
	}, 30_000);

	it("refuses --session-id with --resume, --continue, --fork, --no-session, --goal and ACP mode", async () => {
		using dir = TempDir.createSync("@omp-session-id-pairs-");
		const other = await storeSession(new FileSessionStorage(), dir.path(), LONGER_ID, dir.path(), EARLIER);
		const before = fs.readdirSync(dir.path()).sort();
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
			const result = await launch(["--session-id", SESSION_ID, ...shape.args, "-p", "hello"], dir.path());
			expect(result.exitCode, `${label}: ${result.stderr}`).toBe(2);
			expect(result.stderr, label).toContain(`--session-id cannot be combined with ${shape.names}`);
			expect(fs.readdirSync(dir.path()).sort(), label).toEqual(before);
		}
	}, 120_000);

	it("is dropped from a relaunch, which restores the session instead", () => {
		expect(restartArgv(["--session-id", SESSION_ID, "--model", "m"], SESSION_ID)).toEqual([
			"--model",
			"m",
			"--restore",
			SESSION_ID,
		]);
	});
});
