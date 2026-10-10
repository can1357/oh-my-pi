/**
 * The shared skill-diagnostic workflow over a real `omp --mode rpc` process: prepare and disclose, start once
 * with consent, observe progress and the result through the existing getters and update frames, cancel, and
 * apply with a separate confirmation. The model is a local OpenAI-compatible server this test controls, so
 * every billed completion is counted and its reply can be held back.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { SkillDiagnosticItem, SkillDiagnosticsSnapshot } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { TempDir } from "@oh-my-pi/pi-utils";

/** A line both variants carry, so the scripted reply can quote it verbatim for either candidate. */
const SHARED_LINE = "Review changes carefully.";

interface FakeModel {
	/** The user message of every completion received; one entry per billed request. */
	readonly prompts: string[];
	readonly port: number;
	/** Hold every reply until {@link release}. */
	hold(): void;
	release(): void;
	/** Resolves once `count` completions have arrived. */
	received(count: number): Promise<void>;
	/** Resolves once `count` replies have been produced (after any hold). */
	served(count: number): Promise<void>;
	stop(): void;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
		.join("");
}

/** A reply that prefers the first candidate and quotes the shared line for every candidate it was shown. */
function scriptedAnalysis(prompt: string): string {
	const files = [...prompt.matchAll(/<<<FILE \w+ (\{.*?\})>>>/g)].map(
		match => JSON.parse(match[1]!) as { candidateId: string; path: string },
	);
	return JSON.stringify({
		relationship: "adaptation",
		evidence: files.map(file => ({
			candidateId: file.candidateId,
			file: file.path,
			quote: SHARED_LINE,
			explanation: "Both variants carry the same checklist line.",
		})),
		differences: ["One variant runs the linter first, the other skips it."],
		recommendation: {
			action: "prefer",
			preferredId: files[0]!.candidateId,
			reason: "The first variant loses nothing.",
		},
		limitations: [],
	});
}

function eventStream(text: string): Response {
	const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model: "fake-model" };
	const chunks = [
		{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		{ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
	];
	const body = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function startFakeModel(): FakeModel {
	const prompts: string[] = [];
	const listeners = new Set<() => void>();
	let served = 0;
	let gate: PromiseWithResolvers<void> | undefined;
	const changed = (): void => {
		for (const listener of listeners) listener();
	};
	const until = (ready: () => boolean): Promise<void> => {
		if (ready()) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		const check = (): void => {
			if (!ready()) return;
			listeners.delete(check);
			resolve();
		};
		listeners.add(check);
		return promise;
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname.endsWith("/models")) {
				return Response.json({ object: "list", data: [{ id: "fake-model", object: "model", owned_by: "fake" }] });
			}
			if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
			const body = (await request.json()) as { messages?: Array<{ role: string; content?: unknown }> };
			const prompt = messageText(body.messages?.at(-1)?.content);
			prompts.push(prompt);
			changed();
			await gate?.promise;
			served += 1;
			changed();
			return eventStream(scriptedAnalysis(prompt));
		},
	});
	return {
		prompts,
		port: server.port ?? 0,
		hold: () => {
			gate = Promise.withResolvers<void>();
		},
		release: () => gate?.resolve(),
		received: count => until(() => prompts.length >= count),
		served: count => until(() => served >= count),
		stop: () => void server.stop(true),
	};
}

async function writeSkill(root: string, name: string, body: string): Promise<string> {
	const filePath = path.join(root, name, "SKILL.md");
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await Bun.write(filePath, body);
	return filePath;
}

interface UpdateLog {
	readonly history: SkillDiagnosticsSnapshot[];
	/** The first update, already received or still to come, that satisfies `ready`. */
	waitFor(ready: (snapshot: SkillDiagnosticsSnapshot) => boolean): Promise<SkillDiagnosticsSnapshot>;
}

function trackUpdates(client: RpcClient): UpdateLog {
	const history: SkillDiagnosticsSnapshot[] = [];
	const waiters = new Set<{
		ready: (snapshot: SkillDiagnosticsSnapshot) => boolean;
		resolve: (snapshot: SkillDiagnosticsSnapshot) => void;
	}>();
	client.onSkillDiagnosticsUpdate(snapshot => {
		history.push(snapshot);
		for (const waiter of waiters) {
			if (!waiter.ready(snapshot)) continue;
			waiters.delete(waiter);
			waiter.resolve(snapshot);
		}
	});
	return {
		history,
		waitFor(ready) {
			const past = history.find(ready);
			if (past) return Promise.resolve(past);
			const { promise, resolve } = Promise.withResolvers<SkillDiagnosticsSnapshot>();
			waiters.add({ ready, resolve });
			return promise;
		},
	};
}

interface Fixture extends AsyncDisposable {
	client: RpcClient;
	model: FakeModel;
	updates: UpdateLog;
	configFile: string;
}

async function startFixture(temp: TempDir): Promise<Fixture> {
	const project = temp.join("project");
	const agentDir = temp.join("agent");
	const roots = [temp.join("first"), temp.join("second"), temp.join("solo")];
	await Promise.all([fs.mkdir(project), fs.mkdir(agentDir)]);
	await writeSkill(
		roots[0]!,
		"review",
		`---\nname: review\ndescription: First\n---\n\n# First\n${SHARED_LINE}\nRun the linter first.\n`,
	);
	await writeSkill(
		roots[1]!,
		"review",
		`---\nname: review\ndescription: Second\n---\n\n# Second\n${SHARED_LINE}\nSkip the linter.\n`,
	);
	await writeSkill(roots[2]!, "solo", "---\nname: solo\ndescription: Alone\n---\n\n# Solo\n");
	const model = startFakeModel();
	await Bun.write(
		path.join(agentDir, "models.yml"),
		[
			"providers:",
			"  fake:",
			`    baseUrl: http://127.0.0.1:${model.port}/v1`,
			"    auth: none",
			"    api: openai-completions",
			"    models:",
			"      - id: fake-model",
			"        name: Fake Model",
			"        reasoning: false",
			"",
		].join("\n"),
	);
	const configFile = path.join(agentDir, "config.yml");
	await Bun.write(
		configFile,
		[
			"skills:",
			"  enableCodexUser: false",
			"  enableClaudeUser: false",
			"  enableClaudeProject: false",
			"  enablePiUser: false",
			"  enablePiProject: false",
			"  enableAgentsUser: false",
			"  enableAgentsProject: false",
			`  customDirectories: ${JSON.stringify(roots)}`,
			"",
		].join("\n"),
	);
	const client = new RpcClient({
		cliPath: path.join(import.meta.dir, "..", "src", "cli.ts"),
		cwd: project,
		model: "fake/fake-model",
		args: ["--no-extensions", "--no-rules", "--no-tools"],
		env: {
			HOME: path.join(agentDir, "home"),
			PI_CODING_AGENT_DIR: agentDir,
			XDG_CONFIG_HOME: path.join(agentDir, "config"),
			XDG_DATA_HOME: path.join(agentDir, "data"),
			XDG_CACHE_HOME: path.join(agentDir, "cache"),
			CI: "true",
			PI_NO_TITLE: "1",
		},
	});
	await client.start();
	return {
		client,
		model,
		updates: trackUpdates(client),
		configFile,
		async [Symbol.asyncDispose]() {
			await client.stop();
			model.stop();
		},
	};
}

const reviewItem = (snapshot: SkillDiagnosticsSnapshot): SkillDiagnosticItem | undefined =>
	snapshot.items?.find(item => item.name === "review");

/** Statuses of the current `review` analysis across the updates, consecutive repeats collapsed. */
function statusTrail(history: readonly SkillDiagnosticsSnapshot[]): string[] {
	const trail: string[] = [];
	for (const snapshot of history) {
		const status = reviewItem(snapshot)?.analysis?.status;
		if (status !== undefined && trail.at(-1) !== status) trail.push(status);
	}
	return trail;
}

describe("skill diagnostic analysis over RPC", () => {
	test("prepare discloses, one consented start bills once, the result arrives by update, apply is separate and replays", async () => {
		await using temp = await TempDir.create("@rpc-skill-analysis-");
		await using fixture = await startFixture(temp);
		const { client, model, updates, configFile } = fixture;

		// Every loaded skill is a row; only a comparable group can be analyzed.
		const baseline = await client.getSkillDiagnostics();
		const review = reviewItem(baseline)!;
		expect(review).toMatchObject({ canAnalyze: true });
		expect(review.issues).toContain("conflict");
		expect(review.analysis).toBeUndefined();
		const solo = baseline.items!.find(item => item.name === "solo")!;
		expect(solo.canAnalyze).toBe(false);
		expect(solo.issues).not.toContain("conflict");
		expect(solo.unavailableReason).toEqual(expect.any(String));
		expect((await client.getState()).skillDiagnostics).toEqual(baseline);
		expect(model.prompts).toHaveLength(0);

		// Preparing snapshots and discloses; nothing reaches the model.
		const prepared = await client.prepareSkillDiagnosticAnalysis("review", "fake/fake-model");
		expect(prepared).toMatchObject({ name: "review", status: "prepared", applied: false });
		expect(prepared.model).toContain("fake-model");
		expect(prepared.bytes).toBeGreaterThan(0);
		expect(prepared.candidates).toHaveLength(2);
		expect(prepared.candidates.every(candidate => candidate.complete)).toBe(true);
		expect(prepared.disclosure.length).toBeGreaterThan(0);
		expect(prepared.result).toBeUndefined();
		expect(reviewItem(await client.getSkillDiagnostics())?.analysis).toEqual(prepared);
		expect(model.prompts).toHaveLength(0);

		// Consent is its own boolean: anything but `true`, an unissued id, or a non-string id starts nothing.
		for (const consent of [false, "true", 1, undefined]) {
			await expect(client.analyzeSkillDiagnostics(prepared.id, consent as boolean)).rejects.toThrow(/consent/);
		}
		await expect(client.analyzeSkillDiagnostics("not-an-issued-id", true)).rejects.toThrow();
		await expect(client.analyzeSkillDiagnostics(42 as unknown as string, true)).rejects.toThrow(/analysisId/);
		expect(model.prompts).toHaveLength(0);
		expect(reviewItem(await client.getSkillDiagnostics())?.analysis).toEqual(prepared);

		// Starting answers at once with the running record even though the model has not replied.
		model.hold();
		const running = await client.analyzeSkillDiagnostics(prepared.id, true);
		expect(running).toMatchObject({ id: prepared.id, status: "running" });
		await model.received(1);
		expect(reviewItem(await client.getSkillDiagnostics())?.analysis).toMatchObject({
			id: prepared.id,
			status: "running",
		});
		expect(
			reviewItem(await updates.waitFor(snapshot => reviewItem(snapshot)?.analysis?.status === "running")),
		).toBeDefined();

		// A repeated start replays the state and never bills a second completion.
		expect(await client.analyzeSkillDiagnostics(prepared.id, true)).toMatchObject({
			id: prepared.id,
			status: "running",
		});

		model.release();
		const completed = reviewItem(
			await updates.waitFor(snapshot => reviewItem(snapshot)?.analysis?.status === "complete"),
		)!;
		const record = completed.analysis!;
		expect(record.result).toMatchObject({
			relationship: "adaptation",
			recommendation: { action: "prefer", preferredId: prepared.candidates[0]!.id },
		});
		expect(record.result!.evidence.map(evidence => evidence.candidateId).sort()).toEqual(
			prepared.candidates.map(candidate => candidate.id).sort(),
		);
		expect(record.applied).toBe(false);
		expect(reviewItem(await client.getSkillDiagnostics())?.analysis).toEqual(record);
		expect((await client.getState()).skillDiagnostics).toEqual(await client.getSkillDiagnostics());
		expect(await client.analyzeSkillDiagnostics(prepared.id, true)).toEqual(record);
		expect(model.prompts).toHaveLength(1);
		expect(statusTrail(updates.history)).toEqual(["prepared", "running", "complete"]);

		// Applying is a separate confirmation and mutates once.
		const before = await Bun.file(configFile).text();
		await expect(client.applySkillDiagnosticAnalysis(prepared.id, false)).rejects.toThrow(/confirmed/);
		await expect(client.applySkillDiagnosticAnalysis(prepared.id, "true" as unknown as boolean)).rejects.toThrow(
			/confirmed/,
		);
		expect(await Bun.file(configFile).text()).toBe(before);

		const applied = await client.applySkillDiagnosticAnalysis(prepared.id, true);
		expect(applied).toMatchObject({ id: prepared.id, status: "applied", applied: true });
		expect(applied.result).toEqual(record.result);
		const preferred = prepared.candidates.find(
			candidate => candidate.id === record.result!.recommendation.preferredId,
		)!;
		const hidden = prepared.candidates.find(candidate => candidate !== preferred)!;
		const afterApply = await Bun.file(configFile).text();
		expect(afterApply).not.toBe(before);
		expect(afterApply).toContain(await fs.realpath(hidden.root));

		expect(await client.applySkillDiagnosticAnalysis(prepared.id, true)).toEqual(applied);
		expect(await Bun.file(configFile).text()).toBe(afterApply);
		expect(model.prompts).toHaveLength(1);

		// The applied group stays inspectable while the hidden copy no longer loads.
		const after = await client.getSkillDiagnostics();
		expect(after.diagnostics.some(diagnostic => diagnostic.name === "review")).toBe(false);
		const afterReview = reviewItem(after)!;
		expect([afterReview.analysis, afterReview.lastAnalysis].some(candidate => candidate?.status === "applied")).toBe(
			true,
		);
	}, 90_000);

	test("cancel stops the work, replays, and a late model reply cannot complete it", async () => {
		await using temp = await TempDir.create("@rpc-skill-analysis-cancel-");
		await using fixture = await startFixture(temp);
		const { client, model, updates } = fixture;

		const prepared = await client.prepareSkillDiagnosticAnalysis("review", "fake/fake-model");
		model.hold();
		expect(await client.analyzeSkillDiagnostics(prepared.id, true)).toMatchObject({ status: "running" });
		await model.received(1);

		const cancelled = await client.cancelSkillDiagnosticAnalysis(prepared.id);
		expect(cancelled).toMatchObject({ id: prepared.id, status: "cancelled" });
		await updates.waitFor(snapshot => reviewItem(snapshot)?.analysis?.status === "cancelled");

		// The reply that was in flight when it was cancelled arrives afterwards and changes nothing.
		model.release();
		await model.served(1);
		await client.getState();
		const current = reviewItem(await client.getSkillDiagnostics())!;
		expect(current.analysis).toMatchObject({ id: prepared.id, status: "cancelled" });
		expect(current.analysis?.result).toBeUndefined();
		expect(updates.history.some(snapshot => reviewItem(snapshot)?.analysis?.status === "complete")).toBe(false);
		expect(JSON.stringify(updates.history)).not.toContain(SHARED_LINE);

		expect(await client.cancelSkillDiagnosticAnalysis(prepared.id)).toMatchObject({ status: "cancelled" });
		await expect(client.applySkillDiagnosticAnalysis(prepared.id, true)).rejects.toThrow();
		await expect(client.cancelSkillDiagnosticAnalysis("not-an-issued-id")).rejects.toThrow();
		await expect(client.cancelSkillDiagnosticAnalysis(7 as unknown as string)).rejects.toThrow(/analysisId/);
		expect(model.prompts).toHaveLength(1);
	}, 60_000);

	test("a session change aborts running work and its late reply never reaches the new session", async () => {
		await using temp = await TempDir.create("@rpc-skill-analysis-session-");
		await using fixture = await startFixture(temp);
		const { client, model, updates } = fixture;

		const prepared = await client.prepareSkillDiagnosticAnalysis("review", "fake/fake-model");
		model.hold();
		await client.analyzeSkillDiagnostics(prepared.id, true);
		await model.received(1);

		const framesBefore = updates.history.length;
		expect(await client.newSession()).toEqual({ cancelled: false });
		model.release();
		await model.served(1);
		await client.getState();

		const sinceChange = JSON.stringify(updates.history.slice(framesBefore));
		expect(sinceChange).not.toContain('"status":"complete"');
		expect(sinceChange).not.toContain(SHARED_LINE);
		const current = reviewItem(await client.getSkillDiagnostics())!;
		expect(current.analysis?.status).not.toBe("running");
		expect(current.analysis?.status).not.toBe("complete");
		await expect(client.applySkillDiagnosticAnalysis(prepared.id, true)).rejects.toThrow();
		expect(model.prompts).toHaveLength(1);
	}, 60_000);

	test("bad requests fail with an error response, change nothing, and never reach the model", async () => {
		await using temp = await TempDir.create("@rpc-skill-analysis-errors-");
		await using fixture = await startFixture(temp);
		const { client, model, updates } = fixture;
		const baseline = await client.getSkillDiagnostics();
		const framesBefore = updates.history.length;

		await expect(client.prepareSkillDiagnosticAnalysis(7 as unknown as string)).rejects.toThrow(/name/);
		await expect(client.prepareSkillDiagnosticAnalysis("review", 7 as unknown as string)).rejects.toThrow(/model/);
		await expect(client.prepareSkillDiagnosticAnalysis("no-such-skill")).rejects.toThrow();
		// One loaded copy has nothing to compare.
		await expect(client.prepareSkillDiagnosticAnalysis("solo", "fake/fake-model")).rejects.toThrow();
		// An explicit model must be exactly one authenticated model; no fuzzy match or fallback.
		await expect(client.prepareSkillDiagnosticAnalysis("review", "fake/not-a-model")).rejects.toThrow(/not-a-model/);
		await expect(client.applySkillDiagnosticAnalysis(7 as unknown as string, true)).rejects.toThrow(/analysisId/);
		await expect(client.applySkillDiagnosticAnalysis("not-an-issued-id", true)).rejects.toThrow();

		expect(await client.getSkillDiagnostics()).toEqual(baseline);
		expect(updates.history).toHaveLength(framesBefore);
		expect(model.prompts).toHaveLength(0);
	}, 60_000);
});
