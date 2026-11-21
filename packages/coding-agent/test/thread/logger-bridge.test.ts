import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { loggerThreadService } from "../../src/thread/services/logging";
import type { LoggerProbe } from "../fixtures/logger-bridge-worker";
import { type ServiceWorker, startServiceWorker } from "../helpers/service-worker";

interface FileRecord {
	timestamp: string;
	level: string;
	pid: number;
	message: string;
	[key: string]: unknown;
}

describe("logger thread service", () => {
	let dir: TempDir;
	let logsDir = "";
	let events: logger.LogEvent[] = [];
	let unregister: () => void = () => {};
	let fixture: ServiceWorker<LoggerProbe> | undefined;

	beforeEach(async () => {
		dir = TempDir.createSync("@pi-logger-bridge-");
		logsDir = path.join(dir.path(), "logs");
		logger.setTransports({ console: false, file: logsDir });
		events = [];
		unregister = logger.registerLogSink(event => {
			if (event.context?.thread === "w1" || event.context?.foreign === true) events.push(event);
		});
		fixture = await startServiceWorker<LoggerProbe>(new URL("../fixtures/logger-bridge-worker.ts", import.meta.url), [
			loggerThreadService,
		]);
	});

	afterEach(async () => {
		await fixture?.stop();
		fixture = undefined;
		unregister();
		logger.setTransports({ file: true });
		await dir.remove();
	});

	async function fileRecords(): Promise<FileRecord[]> {
		logger.flush();
		const names = await fs.readdir(logsDir);
		expect(names).toHaveLength(1);
		const text = await Bun.file(path.join(logsDir, names[0] ?? "")).text();
		return text
			.trim()
			.split("\n")
			.map((line): FileRecord => JSON.parse(line));
	}

	it("delivers worker records with scoped and call fields and the thread tag to main's sinks", async () => {
		await fixture?.probe.log([{ level: "info", message: "worker hello", context: { tool: "grep", count: 2 } }], {
			sessionId: "child-1",
		});
		const hello = events.find(event => event.message === "worker hello");
		expect(hello?.level).toBe("info");
		expect(hello?.context).toEqual({ sessionId: "child-1", tool: "grep", count: 2, thread: "w1" });
		expect(hello?.timestamp).toBeInstanceOf(Date);

		const line = (await fileRecords()).find(record => record.message === "worker hello");
		expect(line).toMatchObject({ level: "info", pid: process.pid, sessionId: "child-1", tool: "grep", thread: "w1" });
		expect(new Date(line?.timestamp ?? 0).getTime()).toBe(hello?.timestamp.getTime() ?? -1);
	});

	it("keeps send order, starting with records logged before boot", async () => {
		await fixture?.probe.log([
			{ level: "debug", message: "one" },
			{ level: "warn", message: "two" },
			{ level: "error", message: "three" },
			{ level: "info", message: "four" },
		]);
		expect(events.map(event => [event.level, event.message])).toEqual([
			["info", "before boot"],
			["debug", "one"],
			["warn", "two"],
			["error", "three"],
			["info", "four"],
		]);
		expect(events[0]?.context).toEqual({ phase: "install", thread: "w1" });
		const lines = (await fileRecords()).filter(record => record.thread === "w1").map(record => record.message);
		expect(lines).toEqual(["before boot", "one", "two", "three", "four"]);
	});

	it("forwards errors in the context as plain fields", async () => {
		await fixture?.probe.logError("boom");
		const failure = events.find(event => event.message === "probe failure");
		const error = failure?.context?.error;
		expect(error).toMatchObject({ name: "Error", message: "boom" });
		expect(typeof Reflect.get(Object(error), "stack")).toBe("string");
	});

	it("flushes main's file from the worker", async () => {
		await fixture?.probe.log([{ level: "info", message: "flushed" }]);
		expect(await fixture?.probe.flush()).toBe(true);
		const names = await fs.readdir(logsDir);
		const text = await Bun.file(path.join(logsDir, names[0] ?? "")).text();
		expect(text).toContain('"message":"flushed"');
	});

	it("writes a foreign record without the caller's withContext fields", async () => {
		const timestamp = new Date(Date.now() - 60_000);
		logger.withContext({ sessionId: "main-session" }, () =>
			logger.emitForeign({ level: "info", message: "foreign record", context: { foreign: true }, timestamp }),
		);
		expect(events.find(event => event.message === "foreign record")?.context).toEqual({ foreign: true });
		const line = (await fileRecords()).find(record => record.message === "foreign record");
		expect(line?.sessionId).toBeUndefined();
		expect(new Date(line?.timestamp ?? 0).getTime()).toBe(timestamp.getTime());
	});
});
