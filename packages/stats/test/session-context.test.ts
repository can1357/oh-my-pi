import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { foldContextTimeline } from "@oh-my-pi/pi-ai/context-insights";
import {
	CONTEXT_FIXTURE_CWD,
	CONTEXT_FIXTURE_SESSION_ID,
	contextSessionFixture,
} from "../../ai/test/fixtures/context-session";
import { expectContextTimelineParity } from "../../ai/test/context-insights-assertions";
import { getSessionContext } from "../src/client/api";
import { cachedEntry, loadQuery } from "../src/client/data/query-store";
import { buildSessionContextResponse, buildSessionContextTimeline } from "../src/context";
import { discoverChildTranscripts, MAX_TRACK_DEPTH, TracePathError, transcriptStem } from "../src/trace";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import * as context from "../src/context";
import { handleApi } from "../src/server";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-session-context-");

function assistant(id: string, parentId: string | null = null, input = 100) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-10-21T00:00:00.000Z",
		message: {
			role: "assistant",
			timestamp: 1792540800000,
			model: "model-a",
			provider: "test",
			content: [],
			usage: { input, output: 10, cacheRead: 20, cacheWrite: 0, cost: { total: 0.25 } },
		},
	};
}

async function fixture(name: string, entries: unknown[]) {
	const file = path.join(getSessionsDir(), "--work--project", `${name}.jsonl`);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
	return file;
}

function request(file: string, etag?: string) {
	return handleApi(
		new Request(`http://localhost/api/session/context?${new URLSearchParams({ file })}`, {
			headers: etag ? { "If-None-Match": etag } : undefined,
		}),
	);
}

describe("session context", () => {
	it("matches the fold cost oracle across mixed usage shapes", async () => {
		const shapes = [
			{ contextTokens: 0.5, input: 100, cost: 7 },
			{ input: -5, cacheRead: 2, cost: 7 },
			{ contextTokens: Number.NaN, input: 3, cost: 2 },
			{ contextTokens: undefined, input: 0, cacheRead: 0, cost: 9 },
			{ contextTokens: 2.9, input: 100, cost: 3 },
			{ contextTokens: 0, input: 100, cost: 11 },
		];
		const entries: unknown[] = [{ type: "session", id: "session-mixed-cost", cwd: "/work/project" }];
		let parent: string | null = null;
		for (const [index, shape] of shapes.entries()) {
			const id = `m${index}`;
			const base = assistant(id, parent, 10);
			entries.push({
				...base,
				message: {
					...base.message,
					usage: {
						input: shape.input,
						output: 1,
						...(shape.cacheRead !== undefined ? { cacheRead: shape.cacheRead } : {}),
						...(shape.contextTokens !== undefined ? { contextTokens: shape.contextTokens } : {}),
						cost: { total: shape.cost },
					},
				},
			});
			parent = id;
		}
		const file = await fixture("mixed-cost", entries);
		const timeline = await buildSessionContextTimeline(file);
		const oracle = foldContextTimeline({
			sessionId: "session-mixed-cost",
			source: "journal",
			entries: entries.slice(1) as never,
		});
		expect(timeline.agents[0]?.costTotal).toBe(oracle.costTotal);
		expect(timeline.agents[0]?.requests).toBe(oracle.steps.length + oracle.omittedSteps);
	});

	it("excludes zero-context-token assistants from fleet cost", async () => {
		const entries: unknown[] = [
			{ type: "session", id: "session-zero-context", cwd: "/work/project" },
			assistant("a1", null, 1),
			{
				...assistant("a2", "a1", 3),
				message: {
					...assistant("a2", "a1", 3).message,
					usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, contextTokens: 0, cost: { total: 3 } },
				},
			},
			{
				...assistant("a3", "a2", 4),
				message: {
					...assistant("a3", "a2", 4).message,
					usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, contextTokens: 0, cost: { total: 4 } },
				},
			},
		];
		const file = await fixture("zero-context-cost", entries);
		const timeline = await buildSessionContextTimeline(file);
		expect(timeline.steps.map(step => step.id)).toEqual(["a1"]);
		expect(timeline.agents[0]).toMatchObject({ requests: 1, costTotal: 0.25 });
	});

	it("keeps fleet cost over the full branch when steps are truncated", async () => {
		const entries: unknown[] = [{ type: "session", id: "session-cost", cwd: "/work/project" }];
		let parent: string | null = null;
		for (let index = 0; index < 1001; index++) {
			const id = `s${index}`;
			const input = index === 0 ? 9000 : 1;
			entries.push({
				...assistant(id, parent, input),
				message: { ...assistant(id, parent, input).message, usage: { input, output: 1, cost: { total: 1 } } },
			});
			parent = id;
		}
		const file = await fixture("cost-cap", entries);
		const timeline = await buildSessionContextTimeline(file);
		expect(timeline.steps).toHaveLength(1000);
		expect(timeline.omittedSteps).toBe(1);
		expect(timeline.steps.at(-1)?.promptTokens).toBe(1);
		expect(timeline.agents[0]).toMatchObject({ trackId: "main", requests: 1001, costTotal: 1001, peakTokens: 9000 });
	});

	it("serves the active branch, not a stale sibling, with a reusable ETag", async () => {
		const file = await fixture("route", [
			{ type: "session", id: "session-route", cwd: "/work/project" },
			assistant("a1"),
			assistant("stale", "a1", 900),
			assistant("a2", "a1", 200),
		]);
		const response = await request(file);
		expect(response.status).toBe(200);
		const timeline = await response.json();
		expect(timeline.steps.map((step: { id: string }) => step.id)).toEqual(["a1", "a2"]);
		expect(timeline.steps.map((step: { promptTokens: number }) => step.promptTokens)).toEqual([120, 220]);
		expect(timeline.source).toBe("journal");
		expect(timeline.agents).toHaveLength(1);
		expect(timeline.agents[0]).toMatchObject({ trackId: "main", requests: 2, peakTokens: 220, lastTokens: 220 });
		const etag = response.headers.get("ETag");
		expect(etag).toBeTruthy();
		const unchanged = await request(file, etag!);
		expect(unchanged.status).toBe(304);
		expect(unchanged.headers.get("ETag")).toBe(etag);
		expect(await unchanged.text()).toBe("");
	});

	it("exposes the timeline adapter contract", async () => {
		const file = await fixture("adapter", [assistant("a1")]);
		expect("buildSessionContextTimeline" in context).toBe(true);
		if (!("buildSessionContextTimeline" in context) || typeof context.buildSessionContextTimeline !== "function") {
			throw new Error("timeline adapter missing");
		}
		expect((await context.buildSessionContextTimeline(file)).steps).toHaveLength(1);
	});
});

describe("journal context integration", () => {
	it("matches the shared TUI fold field-for-field on the six-step fixture", async () => {
		const data = contextSessionFixture();
		const file = await fixture("parity", data.entries);
		const actual = await buildSessionContextTimeline(file);
		const expected = foldContextTimeline({
			sessionId: CONTEXT_FIXTURE_SESSION_ID,
			file,
			cwd: CONTEXT_FIXTURE_CWD,
			source: "journal",
			entries: data.branch,
			agents: [],
			normalizePath: value => path.resolve(CONTEXT_FIXTURE_CWD, value.replace(/:[\d-]+:raw$/, "")),
		});
		expectContextTimelineParity(actual, expected, { ignoreAgents: true });
		expect(actual.steps.map(step => step.id)).toEqual(["a1", "a2", "a3", "a4", "a5", "a6"]);
		expect(actual.steps.map(step => step.promptTokens)).toEqual([120, 100, 80, 60, 40, 20]);
		expect(actual.events.map(event => event.kind)).toEqual([
			"prune",
			"compact",
			"inject",
			"switch",
			"reset",
			"inject",
		]);
		expect(actual.files).toHaveLength(3);
		expect(actual.incompleteFileCalls).toBe(1);
		expect(actual.legacySteps).toBe(1);
		expect(actual.agents[0]).toMatchObject({ requests: 6, peakTokens: 120, lastTokens: 20, costTotal: 1.5 });
	});

	it.each([
		["captured", { activeLeafId: "a1" }, ["a1"]],
		["cleared", { activeLeafId: null }, []],
		["dangling", { activeLeafId: "missing" }, ["a1", "a2"]],
		["self-selected usage", {}, ["a1"]],
	] as const)("replays %s leaf state", async (name, leaf, ids) => {
		const file = await fixture(name, [
			assistant("a1"),
			assistant("a2", "a1"),
			{ type: "model_usage", id: "usage", parentId: "a1", ...leaf },
			{ type: "title", title: "ignored" },
		]);
		expect((await buildSessionContextTimeline(file)).steps.map(step => step.id)).toEqual([...ids]);
	});

	it("retains first-occurrence fold semantics while terminating parent cycles", async () => {
		const file = await fixture("duplicates-cycle", [
			assistant("a1", "a2", 100),
			assistant("a2", "a1", 200),
			assistant("a1", "a2", 900),
		]);
		const timeline = await buildSessionContextTimeline(file);
		expect(timeline.steps.map(step => step.id)).toEqual(["a1", "a2"]);
		expect(timeline.steps.map(step => step.promptTokens)).toEqual([120, 220]);
	});

	it("reads gzip roots, recursive gzip children and advisors; skips corrupt children", async () => {
		const plain = await fixture("compressed", [assistant("root")]);
		const root = `${plain}.gz`;
		await Bun.write(root, Bun.gzipSync(await Bun.file(plain).bytes()));
		const dir = transcriptStem(root);
		await fs.mkdir(path.join(dir, "Scout1"), { recursive: true });
		await Bun.write(path.join(dir, "Scout1.jsonl.gz"), Bun.gzipSync(JSON.stringify(assistant("child", null, 200))));
		await Bun.write(path.join(dir, "Scout1", "Nested.jsonl"), JSON.stringify(assistant("nested", null, 300)));
		await Bun.write(path.join(dir, "__advisor.jsonl.gz"), Bun.gzipSync(JSON.stringify(assistant("advisor"))));
		await Bun.write(path.join(dir, "__advisor.review.jsonl"), JSON.stringify(assistant("advisor-review")));
		await Bun.write(path.join(dir, "ignored.jsonl.bak"), JSON.stringify(assistant("ignored")));
		await Bun.write(path.join(dir, "corrupt.jsonl.gz"), "not gzip");
		const timeline = await buildSessionContextTimeline(root);
		expect(timeline.agents.map(agent => agent.trackId)).toEqual([
			"main",
			"Scout1",
			"Scout1/Nested",
			"__advisor",
			"__advisor.review",
		]);
		expect(timeline.agents.map(agent => agent.status)).toEqual([
			"main",
			"subagent",
			"subagent",
			"advisor",
			"advisor",
		]);
		expect(timeline.agents.map(agent => agent.requests)).toEqual([1, 1, 1, 1, 1]);
		expect(timeline.agents[1]).toMatchObject({ peakTokens: 220, lastTokens: 220, costTotal: 0.25 });
		expect(timeline.agents[3]!.label).toBe("Advisor");
		const child = await buildSessionContextTimeline(path.join(dir, "Scout1.jsonl.gz"));
		expect(child.steps.map(step => step.id)).toEqual(["child"]);
		expect(child.agents.map(agent => agent.trackId)).toEqual(["main", "Nested"]);
		expect(child.agents[0]!.status).toBe("subagent");
	});

	it("caps recursive discovery at the same depth as trace tracks", async () => {
		const root = await fixture("depth", [assistant("root")]);
		let file = root;
		for (let depth = 0; depth <= MAX_TRACK_DEPTH; depth++) {
			await fs.mkdir(transcriptStem(file), { recursive: true });
			file = path.join(transcriptStem(file), "child.jsonl");
			await Bun.write(file, JSON.stringify(assistant(`child-${depth}`)));
		}
		expect(await discoverChildTranscripts(root)).toHaveLength(MAX_TRACK_DEPTH);
		expect((await buildSessionContextTimeline(root)).agents).toHaveLength(MAX_TRACK_DEPTH + 1);
	});

	it("returns empty timelines for empty, header-only and malformed transcripts", async () => {
		for (const [name, content] of [
			["empty", ""],
			["header-only", JSON.stringify({ type: "session", id: "empty", cwd: "/work" })],
			["malformed", "garbage\n{broken\nnull\n"],
		]) {
			const file = await fixture(name!, []);
			await Bun.write(file, content!);
			const response = await request(file);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				schemaVersion: 1,
				steps: [],
				events: [],
				files: [],
				agents: [{ trackId: "main", requests: 0, peakTokens: 0, costTotal: 0 }],
			});
		}
		const file = await fixture("mixed-lines", []);
		await Bun.write(file, `garbage\n${JSON.stringify(assistant("valid"))}\n{broken\n`);
		expect((await (await request(file)).json()).steps.map((step: { id: string }) => step.id)).toEqual(["valid"]);
	});

	it("maps guard errors before reading and missing roots to 400/404", async () => {
		expect((await handleApi(new Request("http://localhost/api/session/context"))).status).toBe(400);
		for (const invalid of [
			"../escape.jsonl",
			"/etc/missing.jsonl",
			path.join(getSessionsDir(), "..", "escape.jsonl"),
			"project/not-transcript.txt",
		]) {
			const response = await request(invalid, '"old"');
			expect(response.status).toBe(400);
			await expect(buildSessionContextTimeline(invalid)).rejects.toBeInstanceOf(TracePathError);
		}
		const response = await request("missing/session.jsonl", '"old"');
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "session not found" });
	});

	it("normalizes relative session paths and file selectors without inventing a cwd", async () => {
		const entry = {
			...assistant("paths"),
			message: {
				...assistant("paths").message,
				content: [
					{ type: "toolCall", id: "relative", name: "read", arguments: { path: "./src/../a.ts:2-4:raw" } },
					{ type: "toolCall", id: "absolute", name: "read", arguments: { path: "/extra/dir/../b.ts:img" } },
					{ type: "toolCall", id: "url", name: "read", arguments: { path: "https://example.com/a.ts" } },
				],
			},
		};
		const file = await fixture("paths", [
			{ type: "session", id: "session-paths", cwd: "/work/project", additionalDirectories: ["/extra"] },
			entry,
		]);
		const timeline = await buildSessionContextTimeline(path.relative(getSessionsDir(), file));
		expect(timeline.file).toBe(file);
		expect(timeline.files.map(file => file.path).sort()).toEqual(["/extra/b.ts", "/work/project/a.ts"]);
		const noCwd = await fixture("no-cwd", [entry]);
		expect((await buildSessionContextTimeline(noCwd)).files.map(file => file.path)).toEqual(["/extra/b.ts"]);
	});

	it("invalidates ETags for child append/add/remove/gzip rename and root size with restored mtime", async () => {
		const root = await fixture("etag", [assistant("root")]);
		let etag = (await request(root)).headers.get("ETag")!;
		const dir = transcriptStem(root);
		await fs.mkdir(dir, { recursive: true });
		const child = path.join(dir, "Scout.jsonl");
		const mutations = [
			async () => {
				await Bun.write(child, `${JSON.stringify(assistant("child"))}\n`);
			},
			async () => {
				await fs.appendFile(child, `${JSON.stringify(assistant("child2", "child"))}\n`);
			},
			async () => {
				await Bun.write(`${child}.gz`, Bun.gzipSync(await Bun.file(child).bytes()));
				await fs.unlink(child);
			},
			async () => {
				await fs.unlink(`${child}.gz`);
			},
			async () => {
				const stat = await fs.stat(root);
				await fs.appendFile(root, "\n\n");
				await fs.utimes(root, stat.atime, stat.mtime);
			},
			async () => {
				const stat = await fs.stat(root);
				await fs.utimes(root, stat.atime, new Date(stat.mtimeMs + 10000));
			},
		];
		for (const mutate of mutations) {
			await mutate();
			const changed = await request(root, etag);
			expect(changed.status).toBe(200);
			expect(changed.headers.get("ETag")).not.toBe(etag);
			etag = changed.headers.get("ETag")!;
			const unchanged = await request(root, etag);
			expect(unchanged.status).toBe(304);
			expect(await unchanged.text()).toBe("");
		}
	});

	it("retains the pre-read ETag if children change between fingerprint and build", async () => {
		const root = await fixture("race", [assistant("root")]);
		const before = await context.contextFingerprintForEtag(root);
		await fs.mkdir(transcriptStem(root), { recursive: true });
		await Bun.write(path.join(transcriptStem(root), "new.jsonl"), JSON.stringify(assistant("new")));
		const raced = await buildSessionContextResponse(root, undefined, before);
		expect(raced.etag).toBe(before!.etag);
		const next = await request(root, `"${context.CONTEXT_ETAG_VERSION}:${raced.etag}"`);
		expect(next.status).toBe(200);
		expect((await next.json()).agents).toHaveLength(2);
	});

	it("applies adapter limits but ignores route query overrides", async () => {
		const file = await fixture("limits", contextSessionFixture().entries);
		const limited = await buildSessionContextTimeline(file, {
			maxSteps: 2,
			maxEvents: 1,
			maxFiles: 1,
			maxBrowserEntries: 0,
		});
		expect(limited.steps).toHaveLength(2);
		expect(limited.omittedSteps).toBe(4);
		expect(limited.events).toHaveLength(1);
		expect(limited.omittedEvents).toBe(5);
		expect(limited.files).toHaveLength(1);
		expect(limited.omittedFiles).toBe(2);
		expect(limited.detailsOmittedSteps).toBe(2);
		expect(limited.truncated).toBe(true);
		const response = await handleApi(
			new Request(`http://localhost/api/session/context?${new URLSearchParams({ file, maxSteps: "1" })}`),
		);
		expect((await response.json()).steps).toHaveLength(6);
	});

	it("reuses client validators, previous object and no-store requests on 304", async () => {
		const file = await fixture("client", [assistant("root")]);
		const calls: Request[] = [];
		const fetcher = spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
			const req = new Request(new URL(String(input), "http://localhost"), options);
			calls.push(req);
			return handleApi(req);
		});
		try {
			const first = await getSessionContext(file);
			const second = await getSessionContext(file, undefined, first);
			expect(second).toBe(first);
			expect(calls[0]!.cache).toBe("no-store");
			expect(calls[1]!.headers.get("If-None-Match")).toBeTruthy();
		} finally {
			fetcher.mockRestore();
		}
	});

	it("keeps only four large context timelines in their dedicated cache bucket", async () => {
		const keys = Array.from({ length: 5 }, (_, index) => JSON.stringify(["context-session", `cache-${index}`]));
		for (const key of keys) await loadQuery(key, 1, async () => ({ key })).promise;
		expect(cachedEntry(keys[0]!)).toBeUndefined();
		for (const key of keys.slice(1)) expect(cachedEntry(key)).toBeDefined();
	});
});
