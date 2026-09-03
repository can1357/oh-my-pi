import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	computeSessionStats,
	resolveSessionFile,
	runSessionStatsCommand,
} from "@oh-my-pi/pi-coding-agent/cli/session-stats-cli";

let root: string;
const originalExitCode = process.exitCode;

/** Fixture entries for session "test-session"; e6 is an abandoned fork (off-branch). */
function fixtureLines() {
	const t = (seconds: number) => `2026-01-01T00:00:${String(seconds).padStart(2, "0")}.000Z`;
	const usage = (input: number, output: number, cost: number, cached = 0, cacheWrite = 0) => ({
		input,
		output,
		cacheRead: cached,
		cacheWrite,
		totalTokens: input + output + cached + cacheWrite,
		cost: { total: cost },
	});
	const message = (id: string, parentId: string | null, seconds: number, message: Record<string, unknown>) =>
		JSON.stringify({ type: "message", id, parentId, timestamp: t(seconds), message });
	return [
		// Rewritable title slot — first line, no entry id. Must be skipped.
		JSON.stringify({ type: "title", v: 1, title: "fixture", source: "auto", updatedAt: t(0), pad: " " }),
		JSON.stringify({ type: "session", version: 3, id: "test-session", timestamp: t(0), cwd: "/tmp" }),
		JSON.stringify({ type: "model_change", id: "e1", parentId: null, timestamp: t(1), model: "acme/model-a" }),
		message("e2", "e1", 2, { role: "user", content: "hello" }),
		message("e3", "e2", 3, {
			role: "assistant",
			model: "acme/model-a",
			usage: usage(100, 20, 0.25, 500, 10),
			content: [],
		}),
		// Subagent usage embedded in the completed task tool result.
		message("e4", "e3", 4, {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "task",
			content: [],
			details: { usage: usage(50, 5, 0.125) },
		}),
		// Off-transcript model call (e.g. title generation).
		JSON.stringify({
			type: "model_usage",
			id: "e5",
			parentId: "e4",
			timestamp: t(5),
			purpose: "title",
			role: "smol",
			provider: "acme",
			model: "model-b",
			usage: usage(10, 2, 0.0625),
			stopReason: "stop",
		}),
		// Abandoned fork: parented to e2 but NOT the leaf chain. Must be excluded.
		message("e6", "e2", 4, {
			role: "assistant",
			model: "acme/model-a",
			usage: usage(1000, 1000, 9.99),
			content: [],
		}),
		message("e7", "e5", 6, {
			role: "assistant",
			model: "acme/model-a",
			usage: usage(5, 1, 0.0078125),
			content: [],
		}),
		JSON.stringify({
			type: "custom",
			customType: "session_exit",
			data: { reason: "quit", kind: "normal", recordedAt: t(7) },
			id: "e8",
			parentId: "e7",
			timestamp: t(7),
		}),
	];
}

async function writeSession(project: string, filename: string, lines: string[]): Promise<string> {
	const sessionDir = path.join(root, "sessions", project);
	await fs.mkdir(sessionDir, { recursive: true });
	const file = path.join(sessionDir, `${filename}.jsonl`);
	await fs.writeFile(file, `${lines.join("\n")}\n`);
	return file;
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-stats-"));
	process.exitCode = 0;
});

afterEach(async () => {
	process.exitCode = originalExitCode;
	await fs.rm(root, { recursive: true, force: true });
});

describe("computeSessionStats", () => {
	test("totals the active branch: messages, task results, and model_usage", async () => {
		const file = await writeSession("project", "2026-01-01T00-00-00-000Z_test-session", fixtureLines());
		const stats = await computeSessionStats(file);
		expect(stats.session_id).toBe("test-session");
		expect(stats.input_tokens).toBe(165);
		expect(stats.output_tokens).toBe(28);
		expect(stats.cached_tokens).toBe(500);
		expect(stats.cache_write_tokens).toBe(10);
		expect(stats.total_tokens).toBe(703);
		expect(stats.cost_usd).toBe(0.4453125);
		expect(stats.models).toEqual(["acme/model-a", "acme/model-b"]);
		expect(stats.assistant_messages).toBe(2);
		expect(stats.user_messages).toBe(1);
		expect(stats.exit_reason).toBe("quit");
		expect(stats.started).toBe("2026-01-01T00:00:00.000Z");
		expect(stats.ended).toBe("2026-01-01T00:00:07.000Z");
	});

	test("excludes usage on abandoned forks (off the leaf chain)", async () => {
		const lines = fixtureLines().slice(0, 8); // e6 present, no e7/e8 leaf chain through it
		const file = await writeSession("project", "2026-01-01T00-00-00-000Z_fork", lines);
		const stats = await computeSessionStats(file);
		// Leaf is e6 (the fork), so the branch is e6 → e2 → e1: e3/e4/e5 excluded.
		expect(stats.input_tokens).toBe(1000);
		expect(stats.output_tokens).toBe(1000);
		expect(stats.cost_usd).toBe(9.99);
	});

	test("ended comes from the active branch, not off-branch forks", async () => {
		// Leaf chain ends at t3; an abandoned fork parented to e2 and written
		// LATER (t40) must not set `ended` nor leak usage into the totals.
		const t = (s: number) => `2026-01-01T00:00:${String(s).padStart(2, "0")}.000Z`;
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "fork-tail", timestamp: t(0), cwd: "/tmp" }),
			JSON.stringify({ type: "model_change", id: "e1", parentId: null, timestamp: t(1), model: "acme/model-a" }),
			JSON.stringify({
				type: "message",
				id: "e2",
				parentId: "e1",
				timestamp: t(2),
				message: { role: "user", content: "hi" },
			}),
			JSON.stringify({
				type: "message",
				id: "e9",
				parentId: "e2",
				timestamp: t(40),
				message: {
					role: "assistant",
					model: "acme/model-a",
					usage: {
						input: 1000,
						output: 1000,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2000,
						cost: { total: 9.99 },
					},
					content: [],
				},
			}),
			JSON.stringify({
				type: "message",
				id: "e3",
				parentId: "e2",
				timestamp: t(3),
				message: {
					role: "assistant",
					model: "acme/model-a",
					usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { total: 0.25 } },
					content: [],
				},
			}),
		];
		const file = await writeSession("project", "2026-01-01T00-00-00-000Z_fork-tail", lines);
		const stats = await computeSessionStats(file);
		expect(stats.ended).toBe(t(3)); // leaf e3, not the fork's t(40)
		expect(stats.cost_usd).toBe(0.25); // fork usage excluded
		expect(stats.assistant_messages).toBe(1);
	});

	test("tolerates a torn tail line from a hard kill", async () => {
		const file = await writeSession("project", "2026-01-01T00-00-00-000Z_torn", fixtureLines());
		await fs.appendFile(file, '{"type":"message","id":"e9","parentId":"e7",\n');
		const stats = await computeSessionStats(file);
		expect(stats.input_tokens).toBe(165);
		expect(stats.cost_usd).toBe(0.4453125);
	});

	test("reports zeros for a header-only session", async () => {
		const file = await writeSession("project", "2026-01-01T00-00-00-000Z_empty", [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "empty",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/tmp",
			}),
		]);
		const stats = await computeSessionStats(file);
		expect(stats.input_tokens).toBe(0);
		expect(stats.cost_usd).toBe(0);
		expect(stats.models).toEqual([]);
	});

	test("throws when the file has no session header", async () => {
		const sessionDir = path.join(root, "sessions", "project");
		await fs.mkdir(sessionDir, { recursive: true });
		const file = path.join(sessionDir, "no-header.jsonl");
		await fs.writeFile(
			file,
			'{"type":"message","id":"x","parentId":null,"timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hi"}}\n',
		);
		await expect(computeSessionStats(file)).rejects.toThrow("no session header");
	});
});

describe("resolveSessionFile", () => {
	test("resolves a .jsonl path directly", async () => {
		const file = await writeSession("project", "2026-01-01T00-00-00-000Z_test-session", fixtureLines());
		expect(await resolveSessionFile(file, root)).toBe(file);
	});

	test("resolves 'previous' to the most recently modified session", async () => {
		const a = await writeSession("project", "2026-01-01T00-00-00-000Z_older", fixtureLines());
		const b = await writeSession("other", "2026-01-02T00-00-00-000Z_newer", fixtureLines());
		const older = new Date(Date.now() - 86_400_000);
		await fs.utimes(a, older, older);
		expect(await resolveSessionFile("previous", root)).toBe(b);
	});

	test("resolves a session id by filename suffix", async () => {
		await writeSession("project", "2026-01-01T00-00-00-000Z_test-session", fixtureLines());
		expect(await resolveSessionFile("test-session", root)).toBe(
			path.join(root, "sessions", "project", "2026-01-01T00-00-00-000Z_test-session.jsonl"),
		);
	});

	test("throws for an unknown id", async () => {
		await writeSession("project", "2026-01-01T00-00-00-000Z_test-session", fixtureLines());
		await expect(resolveSessionFile("no-such-session", root)).rejects.toThrow(`no session with id "no-such-session"`);
	});

	test("throws when the sessions dir is empty", async () => {
		await expect(resolveSessionFile("previous", root)).rejects.toThrow("no persisted sessions found");
	});
});

describe("runSessionStatsCommand", () => {
	test("prints the JSON totals to the output sink", async () => {
		const file = await writeSession("project", "2026-01-01T00-00-00-000Z_test-session", fixtureLines());
		const out: string[] = [];
		const err: string[] = [];
		await runSessionStatsCommand({
			ref: "previous",
			agentDir: root,
			out: text => out.push(text),
			err: text => err.push(text),
		});
		expect(process.exitCode).toBe(0);
		const parsed = JSON.parse(out.join("")) as Record<string, unknown>;
		expect(parsed.session_id).toBe("test-session");
		expect(parsed.input_tokens).toBe(165);
		expect(parsed.output_tokens).toBe(28);
		expect(parsed.cached_tokens).toBe(500);
		expect(parsed.cost_usd).toBe(0.4453125);
		expect(parsed.models).toEqual(["acme/model-a", "acme/model-b"]);
		expect(parsed.session_file).toBe(file);
		expect(err.join("")).toBe("");
	});

	test("sets exit code 1 and an error message for an unknown id", async () => {
		await writeSession("project", "2026-01-01T00-00-00-000Z_test-session", fixtureLines());
		const out: string[] = [];
		const err: string[] = [];
		await runSessionStatsCommand({
			ref: "no-such-session",
			agentDir: root,
			out: text => out.push(text),
			err: text => err.push(text),
		});
		expect(process.exitCode).toBe(1);
		expect(err.join("")).toContain('no session with id "no-such-session"');
		expect(out.join("")).toBe("");
	});
});
