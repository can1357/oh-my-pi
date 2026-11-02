import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

interface LogRecord {
	message: string;
	sessionId?: string;
	probe?: string;
	error?: string;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	logger.setTransports({ file: true });
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A temp dir whose `logs/` receives this test's log records. */
function useLogsDir(): { dir: string; logsDir: string } {
	const dir = TempDir.createSync("@pi-session-log-context-");
	cleanups.push(() => dir.remove());
	const logsDir = path.join(dir.path(), "logs");
	logger.setTransports({ console: false, file: logsDir });
	return { dir: dir.path(), logsDir };
}

async function readRecords(logsDir: string): Promise<LogRecord[]> {
	logger.flush();
	const [logName] = await fs.readdir(logsDir);
	return (await Bun.file(path.join(logsDir, logName)).text())
		.trim()
		.split("\n")
		.map(line => JSON.parse(line) as LogRecord);
}

async function createSession(
	dir: string,
	name: string,
	streamFn: (stream: StreamFn) => StreamFn = stream => stream,
	sessionManager: SessionManager = SessionManager.inMemory(dir),
) {
	const auth = await AuthStorage.create(path.join(dir, `${name}-auth.db`));
	const model = createMockModel({ responses: [{ content: [`${name} done`] }] });
	auth.keys.setRuntime(model.provider, "test-key");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: streamFn(model.stream),
		}),
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(auth, path.join(dir, `${name}-models.yml`)),
	});
	cleanups.push(async () => {
		await session.dispose();
		auth.close();
	});
	return session;
}

it("stamps each in-process session's log records with its own session id", async () => {
	const { dir, logsDir } = useLogsDir();
	const child = await createSession(dir, "child", stream => (...args) => {
		logger.info("log-context probe", { probe: "child request" });
		return stream(...args);
	});
	// The child runs inside the parent's model request, as a subagent runs
	// inside its parent's tool call.
	const parent = await createSession(dir, "parent", stream => async (...args) => {
		logger.info("log-context probe", { probe: "parent before child" });
		await child.prompt("child task");
		logger.info("log-context probe", { probe: "parent after child" });
		return stream(...args);
	});

	await parent.prompt("parent task");

	const probes = (await readRecords(logsDir))
		.filter(record => record.message === "log-context probe")
		.map(({ probe, sessionId }) => ({ probe, sessionId }));
	expect(probes).toEqual([
		{ probe: "parent before child", sessionId: parent.sessionId },
		{ probe: "child request", sessionId: child.sessionId },
		{ probe: "parent after child", sessionId: parent.sessionId },
	]);
	expect(parent.sessionId).not.toBe(child.sessionId);
});

it("names the recipient session on records of an IRC delivery another session sends", async () => {
	const { dir, logsDir } = useLogsDir();
	const recipient = await createSession(dir, "recipient");
	recipient.subscribe(event => {
		if (event.type === "irc_message") throw new Error("recipient listener failed");
	});

	await logger.withContext({ sessionId: "sender-session" }, () =>
		recipient.deliverIrcMessage({ id: "probe", from: "sender", to: "main", body: "hello", ts: Date.now() }),
	);
	await recipient.waitForIdle();

	const failures = (await readRecords(logsDir)).filter(record => record.error === "recipient listener failed");
	expect(failures.length).toBeGreaterThan(0);
	expect(failures.map(record => record.sessionId)).toEqual(failures.map(() => recipient.sessionId));
});

it("follows a session moved off a contended file to its new id", async () => {
	const { dir, logsDir } = useLogsDir();
	const created = SessionManager.create(dir, dir);
	await created.ensureOnDisk();
	const sessionFile = created.getSessionFile();
	if (!sessionFile) throw new Error("expected a persisted session file");
	await created.close();
	const sessionManager = await SessionManager.open(sessionFile, dir, undefined, { suppressBreadcrumb: true });
	const session = await createSession(
		dir,
		"moved",
		stream =>
			(...args) => {
				logger.info("log-context probe");
				return stream(...args);
			},
		sessionManager,
	);
	const originalId = session.sessionId;
	// Another writer replaces the journal, so the next persisted entry moves the
	// session to a sibling file under a new id.
	await Bun.write(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: crypto.randomUUID(), timestamp: new Date().toISOString(), cwd: dir })}\n`,
	);
	sessionManager.appendMessage({ role: "user", content: "claims the replaced journal", timestamp: Date.now() });
	await sessionManager.flush();

	await session.prompt("hello");

	expect(session.sessionId).not.toBe(originalId);
	const probes = (await readRecords(logsDir)).filter(record => record.message === "log-context probe");
	expect(probes.map(record => record.sessionId)).toEqual([session.sessionId]);
});
