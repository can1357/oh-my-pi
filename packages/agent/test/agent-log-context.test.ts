import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

const dir = TempDir.createSync("@pi-agent-log-context-");

afterEach(async () => {
	logger.setTransports({ file: true });
	await dir.remove();
});

it("runs continue()'s queued-message hooks and its loop under the agent's log context", async () => {
	const logsDir = path.join(dir.path(), "logs");
	logger.setTransports({ console: false, file: logsDir });
	const mock = createMockModel({ responses: [{ content: ["done"] }] });
	const streamFn: StreamFn = (...args) => {
		logger.info("log-context probe", { probe: "request" });
		return mock.stream(...args);
	};
	const agent = new Agent({ streamFn });
	agent.logContext = { sessionId: "recipient" };
	agent.addBeforeQueuedMessageDequeueHook(() => logger.info("log-context probe", { probe: "dequeue hook" }));
	agent.followUp({ role: "user", content: [{ type: "text", text: "queued" }], timestamp: Date.now() });

	// The caller runs in another session's context, as an IRC sender does.
	await logger.withContext({ sessionId: "caller" }, () => agent.continue());
	logger.flush();

	const [logName] = await fs.readdir(logsDir);
	const probes = (await Bun.file(path.join(logsDir, logName)).text())
		.trim()
		.split("\n")
		.map(line => JSON.parse(line) as { message: string; probe?: string; sessionId?: string })
		.filter(record => record.message === "log-context probe")
		.map(({ probe, sessionId }) => ({ probe, sessionId }));
	expect(probes[0]).toEqual({ probe: "dequeue hook", sessionId: "recipient" });
	expect(probes.at(-1)).toEqual({ probe: "request", sessionId: "recipient" });
});
