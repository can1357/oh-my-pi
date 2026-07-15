import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { runRuntimeCommand } from "../../src/cli/operational-cli";
import { type JobExecutor, type JsonValue, OperationalStore } from "../../src/operational";

describe("operational runtime CLI", () => {
	let tempDir: TempDir | undefined;
	let store: OperationalStore | undefined;
	const lines: string[] = [];

	afterEach(async () => {
		store?.close();
		store = undefined;
		if (tempDir) {
			try {
				await tempDir.remove();
			} catch {
				// ignore cleanup races on Windows
			}
			tempDir = undefined;
		}
		lines.length = 0;
	});

	function openStore(): OperationalStore {
		if (!tempDir) throw new Error("tempDir missing");
		store = new OperationalStore({
			dbPath: path.join(tempDir.path(), "operational.db"),
			durability: "normal",
		});
		return store;
	}

	function io() {
		return {
			writeStdout: (line: string) => {
				lines.push(line);
			},
			writeStderr: (line: string) => {
				lines.push(`ERR:${line}`);
			},
		};
	}

	it("enqueues omp jobs, lists them, and runs once with injected executor", async () => {
		tempDir = await TempDir.create("@runtime-cli-");
		const s = openStore();
		const seen: string[] = [];
		const executor: JobExecutor = async ctx => {
			seen.push(ctx.job.id);
			return { ok: true };
		};

		await runRuntimeCommand(
			{
				action: "enqueue",
				flags: {
					prompt: "do the thing",
					cwd: tempDir.path(),
					approvalMode: "write",
					json: true,
				},
			},
			{ store: s, executor, io: io(), installSignalHandlers: false },
		);

		const enqueued = JSON.parse(lines.at(-1) ?? "{}") as { id: string; type: string };
		expect(enqueued.type).toBe("omp");

		lines.length = 0;
		await runRuntimeCommand(
			{ action: "list", flags: { json: true } },
			{ store: s, executor, io: io(), installSignalHandlers: false },
		);
		const listed = JSON.parse(lines.at(-1) ?? "[]") as Array<{ id: string }>;
		expect(listed.some(j => j.id === enqueued.id)).toBe(true);

		lines.length = 0;
		await runRuntimeCommand(
			{ action: "run", flags: { once: true, json: true, pollMs: 10 } },
			{ store: s, executor, io: io(), installSignalHandlers: false },
		);
		expect(seen).toEqual([enqueued.id]);
	});

	it("supports state, history search, schedule-add, and corrections", async () => {
		tempDir = await TempDir.create("@runtime-cli-state-");
		const s = openStore();
		const executor: JobExecutor = async () => ({ ok: true });

		await runRuntimeCommand(
			{
				action: "state-set",
				flags: { key: "theme", value: '"dark"', json: true },
			},
			{ store: s, executor, io: io(), installSignalHandlers: false },
		);
		lines.length = 0;
		await runRuntimeCommand(
			{ action: "state-get", flags: { key: "theme", json: true } },
			{ store: s, executor, io: io(), installSignalHandlers: false },
		);
		expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({ key: "theme", value: "dark" });

		await runRuntimeCommand(
			{
				action: "state-set",
				flags: {
					project: tempDir.path(),
					key: "local",
					value: "1",
					json: true,
				},
			},
			{ store: s, executor, io: io(), installSignalHandlers: false },
		);
		lines.length = 0;
		await runRuntimeCommand(
			{
				action: "state-list",
				flags: { project: tempDir.path(), json: true },
			},
			{ store: s, executor, io: io(), installSignalHandlers: false },
		);
		const projectState = JSON.parse(lines.at(-1) ?? "[]") as Array<{ key: string }>;
		expect(projectState.some(e => e.key === "local")).toBe(true);

		s.createEpisode({
			title: "Refactor auth",
			summary: "Moved token refresh into a helper",
			sessionId: "sess-auth",
			tags: ["auth"],
		});
		lines.length = 0;
		await runRuntimeCommand(
			{ action: "history-search", flags: { query: "token", json: true } },
			{ store: s, executor, io: io(), installSignalHandlers: false },
		);
		const episodes = JSON.parse(lines.at(-1) ?? "[]") as Array<{ title: string }>;
		expect(episodes[0]?.title).toContain("Refactor");

		lines.length = 0;
		await runRuntimeCommand(
			{
				action: "schedule-add",
				flags: {
					name: "nightly",
					cron: "0 3 * * *",
					prompt: "triage inbox",
					cwd: tempDir.path(),
					json: true,
				},
			},
			{ store: s, executor, io: io(), installSignalHandlers: false },
		);
		const schedule = JSON.parse(lines.at(-1) ?? "{}") as {
			name: string;
			nextRunAt: number | null;
			payload: JsonValue;
		};
		expect(schedule.name).toBe("nightly");
		expect(typeof schedule.nextRunAt).toBe("number");

		lines.length = 0;
		await runRuntimeCommand(
			{
				action: "correct",
				flags: { summary: "prefer smaller diffs", rating: 4, category: "preference", json: true },
			},
			{ store: s, executor, io: io(), installSignalHandlers: false },
		);
		const correction = JSON.parse(lines.at(-1) ?? "{}") as { kind: string };
		expect(correction.kind).toBe("human_correction");
	});

	it("redacts secret-like values in events output", async () => {
		tempDir = await TempDir.create("@runtime-cli-events-");
		const s = openStore();
		s.appendEvent({
			kind: "outcome",
			payload: {
				apiKey: "sk-secret-value-123456",
				note: "safe",
			},
		});
		await runRuntimeCommand(
			{ action: "events", flags: { json: true } },
			{ store: s, executor: async () => null, io: io(), installSignalHandlers: false },
		);
		const events = JSON.parse(lines.at(-1) ?? "[]") as Array<{ payload: Record<string, string> }>;
		expect(events[0]?.payload.apiKey).toBe("[redacted]");
		expect(events[0]?.payload.note).toBe("safe");
	});
});
