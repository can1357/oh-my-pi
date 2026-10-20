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

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	logger.setTransports({ file: true });
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createSession(dir: string, name: string, streamFn: (stream: StreamFn) => StreamFn) {
	const auth = await AuthStorage.create(path.join(dir, `${name}-auth.db`));
	const model = createMockModel({ responses: [{ content: [`${name} done`] }] });
	auth.keys.setRuntime(model.provider, "test-key");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: streamFn(model.stream),
		}),
		sessionManager: SessionManager.inMemory(dir),
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
	const dir = TempDir.createSync("@pi-session-log-context-");
	cleanups.push(() => dir.remove());
	const logsDir = path.join(dir.path(), "logs");
	logger.setTransports({ console: false, file: logsDir });

	const child = await createSession(dir.path(), "child", stream => (...args) => {
		logger.info("log-context probe", { probe: "child request" });
		return stream(...args);
	});
	// The child runs inside the parent's model request, as a subagent runs
	// inside its parent's tool call.
	const parent = await createSession(dir.path(), "parent", stream => async (...args) => {
		logger.info("log-context probe", { probe: "parent before child" });
		await child.prompt("child task");
		logger.info("log-context probe", { probe: "parent after child" });
		return stream(...args);
	});

	await parent.prompt("parent task");
	logger.flush();

	const [logName] = await fs.readdir(logsDir);
	const probes = (await Bun.file(path.join(logsDir, logName)).text())
		.trim()
		.split("\n")
		.map(line => JSON.parse(line) as { message: string; probe?: string; sessionId?: string })
		.filter(record => record.message === "log-context probe")
		.map(({ probe, sessionId }) => ({ probe, sessionId }));
	expect(probes).toEqual([
		{ probe: "parent before child", sessionId: parent.sessionId },
		{ probe: "child request", sessionId: child.sessionId },
		{ probe: "parent after child", sessionId: parent.sessionId },
	]);
	expect(parent.sessionId).not.toBe(child.sessionId);
});
