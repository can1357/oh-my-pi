import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getOrCreateClient, sendRequest, shutdownAll } from "@oh-my-pi/pi-coding-agent/lsp/client";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

const fixturePath = path.join(import.meta.dir, "..", "fixtures", "fake-lsp-server.ts");
const dir = TempDir.createSync("@pi-lsp-log-context-");

afterEach(async () => {
	await shutdownAll();
	logger.setTransports({ file: true });
	await dir.remove();
});

it("names no session on records of an LSP client shared across sessions", async () => {
	const logsDir = path.join(dir.path(), "logs");
	logger.setTransports({ console: false, file: logsDir });
	const config = { command: process.execPath, args: ["run", fixturePath], fileTypes: [".ts"], rootMarkers: [] };

	const client = await logger.withContext({ sessionId: "first" }, () => getOrCreateClient(config, dir.path(), 5_000));
	await logger.withContext({ sessionId: "second" }, async () => {
		expect(await getOrCreateClient(config, dir.path(), 5_000)).toBe(client);
		await sendRequest(client, "test/junkHeader", {}, undefined, 5_000);
	});
	logger.flush();

	const [logName] = await fs.readdir(logsDir);
	const resync = (await Bun.file(path.join(logsDir, logName)).text())
		.trim()
		.split("\n")
		.map(line => JSON.parse(line) as { message: string; sessionId?: string })
		.filter(record => record.message.startsWith("LSP framing resync"));
	expect(resync).toHaveLength(1);
	expect(resync[0].sessionId).toBeUndefined();
});
