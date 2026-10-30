import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { exportFromFile, exportSessionToHtml, type SessionData } from "../src/export/html";
import type { SessionHeader } from "../src/session/session-entries";
import { SessionManager } from "../src/session/session-manager";
import { collectSubSessions } from "../src/session/sub-sessions";

/**
 * Contract: a session at `<dir>/<name>.jsonl` embeds subagent transcripts from
 * `<dir>/<name>/<AgentId>.jsonl` (recursively) under slash-joined keys, with
 * parent links and replayed leaf ids. Corrupt/empty/backup files are skipped.
 */

function sessionJsonl(
	id: string,
	entryIds: string[],
	previousSessionFiles?: string[],
	cacheKeys?: Pick<SessionHeader, "providerPromptCacheKey" | "taskPromptCacheKey">,
): string {
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp: "2026-06-12T00:00:00.000Z",
			cwd: "/tmp",
			title: `Session ${id}`,
			previousSessionFiles,
			...cacheKeys,
		}),
	];
	let parent: string | null = null;
	for (const entryId of entryIds) {
		lines.push(
			JSON.stringify({
				type: "model_change",
				id: entryId,
				parentId: parent,
				timestamp: "2026-06-12T00:00:01.000Z",
				model: "test/model",
			}),
		);
		parent = entryId;
	}
	return `${lines.join("\n")}\n`;
}

async function readExportData(outputPath: string): Promise<SessionData> {
	const html = await Bun.file(outputPath).text();
	const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
	expect(encoded).toBeDefined();
	return JSON.parse(Buffer.from(encoded!, "base64").toString("utf8")) as SessionData;
}

describe("collectSubSessions", () => {
	let root: string;
	let mainFile: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-subsessions-"));
		mainFile = path.join(root, "main.jsonl");
		await Bun.write(mainFile, sessionJsonl("main", ["m1"]));
	});

	afterEach(async () => {
		await removeWithRetries(root);
	});

	test("collects nested subagent sessions with parent links and leaf ids", async () => {
		await Bun.write(path.join(root, "main/Alpha.jsonl"), sessionJsonl("alpha", ["a1", "a2"]));
		await Bun.write(path.join(root, "main/Alpha/Child.jsonl"), sessionJsonl("child", ["c1"]));
		await Bun.write(path.join(root, "main/Beta.jsonl"), sessionJsonl("beta", ["b1"]));

		const subs = await collectSubSessions(mainFile);

		expect(Object.keys(subs).sort()).toEqual(["Alpha", "Alpha/Child", "Beta"]);
		expect(subs.Alpha).toMatchObject({ agentId: "Alpha", parent: null, leafId: "a2" });
		expect(subs.Alpha.entries.map(e => e.id)).toEqual(["a1", "a2"]);
		expect(subs.Alpha.header?.id).toBe("alpha");
		expect(subs["Alpha/Child"]).toMatchObject({ agentId: "Child", parent: "Alpha", leafId: "c1" });
		expect(subs.Beta).toMatchObject({ agentId: "Beta", parent: null, leafId: "b1" });
	});

	test("selects the leaf a late completion-probe usage entry restored", async () => {
		const lateUsage = JSON.stringify({
			type: "model_usage",
			id: "probe",
			parentId: "a1",
			timestamp: "2026-06-12T00:00:02.000Z",
			activeLeafId: "a2",
			purpose: "task-completion-probe",
			usage: { cost: { total: 0.01 } },
		});
		await Bun.write(path.join(root, "main/Alpha.jsonl"), `${sessionJsonl("alpha", ["a1", "a2"])}${lateUsage}\n`);

		const subs = await collectSubSessions(mainFile);

		expect(subs.Alpha.leafId).toBe("a2");
	});

	test("omits internal routing and move history from standalone HTML and nested sessions", async () => {
		const mainPreviousPath = "/Users/private/main.jsonl";
		const subPreviousPath = "/Users/private/Alpha.jsonl";
		const mainKeys = { providerPromptCacheKey: "private-main-cache", taskPromptCacheKey: "private-parent:reviewer" };
		const subKeys = { providerPromptCacheKey: "private-sub-cache", taskPromptCacheKey: "private-parent:scout" };
		const mainJsonl = sessionJsonl("main", ["m1"], [mainPreviousPath], mainKeys);
		const subJsonl = sessionJsonl("alpha", ["a1"], [subPreviousPath], subKeys);
		const subFile = path.join(root, "main/Alpha.jsonl");
		await Bun.write(mainFile, mainJsonl);
		await Bun.write(subFile, subJsonl);
		const outputPath = path.join(root, "export.html");

		await exportFromFile(mainFile, { outputPath });

		const html = await Bun.file(outputPath).text();
		const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
		expect(encoded).toBeDefined();
		const data = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8")) as {
			header: SessionHeader;
			subSessions: Record<string, { header: SessionHeader }>;
			trace: NonNullable<SessionData["trace"]>;
		};
		expect(data.header.previousSessionFiles).toBeUndefined();
		expect(data.subSessions.Alpha.header.previousSessionFiles).toBeUndefined();
		for (const header of [data.header, data.subSessions.Alpha.header]) {
			expect(header.providerPromptCacheKey).toBeUndefined();
			expect(header.taskPromptCacheKey).toBeUndefined();
		}
		expect(JSON.stringify(data)).not.toContain("private-");
		expect(data.header.id).toBe("main");
		expect(data.subSessions.Alpha.header.id).toBe("alpha");
		expect(data.trace).toMatchObject({
			title: "Session main",
			startedAt: Date.parse("2026-06-12T00:00:00.000Z"),
			summary: { requests: 0, subagents: 1 },
		});
		expect(await Bun.file(mainFile).text()).toBe(mainJsonl);
		expect(await Bun.file(subFile).text()).toBe(subJsonl);
		expect((await collectSubSessions(mainFile)).Alpha.header).toMatchObject(subKeys);
		expect(html).not.toContain(mainPreviousPath);
		expect(html).not.toContain(subPreviousPath);
	});

	for (const source of ["file", "manager"] as const) {
		test(`${source} export embeds nested trace snapshots and honors includeSubSessions`, async () => {
			const startedAt = Date.parse("2026-06-12T00:00:00.000Z");
			const timedSession = (id: string, offset: number) => {
				const timestamp = startedAt + offset;
				return `${sessionJsonl(id, [])}${JSON.stringify({
					type: "message",
					id: `${id}-model`,
					parentId: null,
					timestamp: new Date(timestamp + 3000).toISOString(),
					message: {
						role: "assistant",
						model: "test/model",
						provider: "test",
						api: "openai-completions",
						timestamp,
						completedAt: timestamp + 3000,
						duration: 3000,
						stopReason: "toolUse",
						content: [{ type: "toolCall", id: `${id}-call`, name: "bash", arguments: { command: "pwd" } }],
						usage: {
							input: 10,
							output: 5,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 15,
							cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
						},
					},
				})}\n${JSON.stringify({
					type: "custom",
					id: `${id}-exit`,
					parentId: `${id}-model`,
					timestamp: new Date(timestamp + 5000).toISOString(),
					customType: "session_exit",
					data: {
						kind: "aborted",
						recordedAt: new Date(timestamp + 5000).toISOString(),
						pendingToolCalls: [{ toolCallId: `${id}-call`, toolName: "bash" }],
					},
				})}\n`;
			};
			await Bun.write(mainFile, timedSession("main", 1000));
			await Bun.write(path.join(root, "main/Alpha.jsonl.gz"), Bun.gzipSync(timedSession("alpha", 2000)));
			await Bun.write(
				path.join(root, "main/Alpha/Child.jsonl.gz"),
				Bun.gzipSync(`${timedSession("child", 3000)}{partial\n`),
			);
			await Bun.write(path.join(root, "main/Alpha/Child.jsonl.tombstone"), "");
			await Bun.write(
				path.join(root, "main/__advisor.reviewer.jsonl.gz"),
				Bun.gzipSync(timedSession("advisor", 2500)),
			);

			const exportWith = async (options: { outputPath: string; includeSubSessions: boolean }) => {
				if (source === "file") await exportFromFile(mainFile, options);
				else {
					const sm = await SessionManager.open(mainFile, undefined, undefined, { suppressBreadcrumb: true });
					await exportSessionToHtml(sm, undefined, options);
				}
				return readExportData(options.outputPath);
			};

			const data = await exportWith({ outputPath: path.join(root, `${source}.html`), includeSubSessions: true });
			expect(data.trace?.tracks.map(track => [track.id, track.parentId, track.file])).toEqual([
				["main", null, "main"],
				["Alpha", "main", "Alpha"],
				["Alpha/Child", "Alpha", "Alpha/Child"],
				["__advisor.reviewer", "main", "__advisor.reviewer"],
			]);
			expect(data.trace).toMatchObject({
				file: "main",
				title: "Session main",
				cwd: "/tmp",
				startedAt: startedAt + 1000,
				endedAt: startedAt + 8000,
				summary: { wallMs: 7000, requests: 4, toolCalls: 4, subagents: 3, totalTokens: 60 },
			});
			expect(data.trace?.tracks[2].spans.find(span => span.kind === "tool")).toMatchObject({
				start: startedAt + 6000,
				end: startedAt + 8000,
				unterminated: true,
			});
			expect(data.subSessions?.["Alpha/Child"]).toMatchObject({ aborted: true, malformedRecords: 1 });
			expect(data.trace?.tracks[3].label).toBe("Advisor");
			expect(data.subSessions?.["__advisor.reviewer"].entries.map(entry => entry.id)).toEqual([
				"advisor-model",
				"advisor-exit",
			]);
			expect(JSON.stringify(data.trace)).not.toContain(root);

			const mainOnly = await exportWith({
				outputPath: path.join(root, `${source}-main.html`),
				includeSubSessions: false,
			});
			expect(mainOnly.subSessions).toBeUndefined();
			expect(mainOnly.trace?.tracks.map(track => track.id)).toEqual(["main"]);
			expect(mainOnly.trace?.summary).toMatchObject({ requests: 1, toolCalls: 1, subagents: 0, totalTokens: 15 });
			expect(JSON.stringify(mainOnly)).not.toContain("alpha-model");
			expect(JSON.stringify(mainOnly)).not.toContain("child-model");
			expect(JSON.stringify(mainOnly)).not.toContain("advisor-model");
		});
	}

	test("rejects a missing input without creating session or export files", async () => {
		const missingInput = path.join(root, "missing.jsonl");
		const outputPath = path.join(root, "export.html");

		await expect(exportFromFile(missingInput, { outputPath })).rejects.toThrow(`File not found: ${missingInput}`);
		expect(await Bun.file(missingInput).exists()).toBe(false);
		expect(await Bun.file(outputPath).exists()).toBe(false);
	});

	test("skips corrupt, empty, backup, and non-jsonl files", async () => {
		await Bun.write(path.join(root, "main/Good.jsonl"), sessionJsonl("good", ["g1"]));
		await Bun.write(path.join(root, "main/corrupt.jsonl"), "{not json\n");
		await Bun.write(path.join(root, "main/empty.jsonl"), "");
		await Bun.write(path.join(root, "main/Good.jsonl.123.bak"), sessionJsonl("bak", ["x1"]));
		await Bun.write(path.join(root, "main/notes.md"), "# notes\n");

		const subs = await collectSubSessions(mainFile);

		expect(Object.keys(subs)).toEqual(["Good"]);
	});

	test("keeps advisor and compressed transcript discovery opt-in", async () => {
		await Bun.write(path.join(root, "main/Scout.jsonl"), sessionJsonl("scout", ["s1"]));
		await Bun.write(path.join(root, "main/__advisor.jsonl"), sessionJsonl("adv", ["v1"]));
		await Bun.write(path.join(root, "main/__advisor.reviewer.jsonl"), sessionJsonl("adv2", ["v2"]));
		await Bun.write(path.join(root, "main/Scout/__advisor.jsonl"), sessionJsonl("adv3", ["v3"]));
		await Bun.write(path.join(root, "main/Archived.jsonl.gz"), Bun.gzipSync(sessionJsonl("archived", ["g1"])));

		const subs = await collectSubSessions(mainFile);
		expect(Object.keys(subs)).toEqual(["Scout"]);

		const complete = await collectSubSessions(mainFile, { includeAdvisors: true, includeCompressed: true });
		expect(Object.keys(complete)).toEqual([
			"Archived",
			"Scout",
			"Scout/__advisor",
			"__advisor",
			"__advisor.reviewer",
		]);
	});

	test("validates archived headers and keeps corruption diagnostics through the central parser", async () => {
		await Bun.write(
			path.join(root, "main/Partial.jsonl.gz"),
			Bun.gzipSync(`${sessionJsonl("partial", ["p1"])}{bad\n`),
		);
		await Bun.write(path.join(root, "main/NoHeader.jsonl.gz"), Bun.gzipSync('{"type":"message","id":"orphan"}\n'));
		await Bun.write(path.join(root, "main/Empty.jsonl.gz"), Bun.gzipSync(""));
		await Bun.write(path.join(root, "main/Current.jsonl"), sessionJsonl("current", ["c1"]));
		await Bun.write(path.join(root, "main/Current.jsonl.gz"), Bun.gzipSync(sessionJsonl("old", ["old1"])));
		const unreadable: string[] = [];

		const subs = await collectSubSessions(mainFile, {
			includeCompressed: true,
			onUnreadable: key => unreadable.push(key),
		});

		expect(Object.keys(subs)).toEqual(["Current", "Partial"]);
		expect(subs.Partial).toMatchObject({
			header: { id: "partial", title: "Session partial" },
			leafId: "p1",
			malformedRecords: 1,
		});
		expect(subs.Current.header?.id).toBe("current");
		expect(unreadable).toEqual(["NoHeader"]);
	});

	test("terminates when a transcript stem names the directory itself", async () => {
		// "..jsonl" has the stem "."; descending into `<dir>/.` used to rescan the same directory forever.
		await Bun.write(path.join(root, "main/..jsonl"), sessionJsonl("dot", ["d1"]));
		await Bun.write(path.join(root, "main/Scout.jsonl"), sessionJsonl("scout", ["s1"]));

		const subs = await collectSubSessions(mainFile);

		expect(Object.keys(subs).sort()).toEqual([".", "Scout"]);
	});

	test("flags subagents killed with a tombstone sidecar as aborted", async () => {
		await Bun.write(path.join(root, "main/Killed.jsonl"), sessionJsonl("killed", ["k1"]));
		await Bun.write(path.join(root, "main/Killed.jsonl.tombstone"), "");
		await Bun.write(path.join(root, "main/Live.jsonl"), sessionJsonl("live", ["l1"]));

		const subs = await collectSubSessions(mainFile);

		expect(subs.Killed.aborted).toBe(true);
		expect(subs.Live.aborted).toBe(false);
	});

	test("returns empty record when no subagent dir exists", async () => {
		expect(await collectSubSessions(mainFile)).toEqual({});
		expect(await collectSubSessions(path.join(root, "not-a-session"))).toEqual({});
	});
});
