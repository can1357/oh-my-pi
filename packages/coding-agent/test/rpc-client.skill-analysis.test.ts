import { describe, expect, test } from "bun:test";
import { type RpcAgentProcess, RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { SkillDiagnosticsSnapshot } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

type Request = { id: string; type: string } & Record<string, unknown>;
type Reply = { data: unknown } | { error: string };

/** An RpcClient wired to a scripted agent: `respond` answers each command, `emit` pushes unsolicited frames. */
async function scriptedClient(respond: (request: Request) => Reply) {
	const encoder = new TextEncoder();
	const exited = Promise.withResolvers<number>();
	let stdout!: ReadableStreamDefaultController<Uint8Array>;
	const emit = (frame: unknown): void => stdout.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
	const proc: RpcAgentProcess = {
		stdin: {
			write(data: string) {
				const request = JSON.parse(data) as Request;
				const reply = respond(request);
				emit({
					id: request.id,
					type: "response",
					command: request.type,
					...("error" in reply ? { success: false, error: reply.error } : { success: true, data: reply.data }),
				});
				return data.length;
			},
		},
		stdout: new ReadableStream<Uint8Array>({
			start(controller) {
				stdout = controller;
				emit({ type: "ready" });
			},
		}),
		peekStderr: () => "",
		kill: () => exited.resolve(0),
		exited: exited.promise,
	};
	const client = new RpcClient({ spawn: () => proc });
	await client.start();
	return { client, emit };
}

const entry = { name: "review", filePath: "/a/review/SKILL.md", source: "custom:user" };

function candidate(id: string) {
	return {
		id,
		name: "review",
		filePath: `/${id}/review/SKILL.md`,
		root: `/${id}/review`,
		fingerprint: "f".repeat(64),
		complete: true,
		files: 1,
		omissions: [],
	};
}

const analysis = {
	relationship: "adaptation",
	evidence: [
		{ candidateId: "a", file: "SKILL.md", quote: "Review changes carefully.", explanation: "Both carry it." },
		{ candidateId: "b", file: "SKILL.md", quote: "Review changes carefully.", explanation: "Both carry it." },
	],
	differences: ["The second variant words the checklist differently."],
	recommendation: { action: "prefer", preferredId: "a", reason: "The first variant loses nothing." },
	limitations: ["Only SKILL.md was compared."],
};

function record(overrides: Record<string, unknown> = {}) {
	return {
		id: "analysis-1",
		name: "review",
		status: "prepared",
		model: "fake/fake-model",
		bytes: 120,
		candidates: [candidate("a"), candidate("b")],
		disclosure: "Sends 2 skill files (120 bytes) to fake/fake-model.",
		createdAt: 1_700_000_000_000,
		applied: false,
		...overrides,
	};
}

function item(overrides: Record<string, unknown> = {}) {
	return {
		name: "review",
		issues: ["conflict", "redundancy"],
		skills: [entry],
		duplicates: [{ skill: entry, retained: entry, match: "content" }],
		reason: "source-order",
		canAnalyze: true,
		...overrides,
	};
}

function snapshot(items?: unknown[]) {
	return { cwd: "/workspace", showStartupDiagnostics: true, diagnostics: [], ...(items && { items }) };
}

describe("RpcClient skill diagnostic analysis decoding", () => {
	test("retains per-skill rows, records and structured results from getters and update frames", async () => {
		const full = snapshot([
			item({
				analysis: record({ status: "complete", result: analysis }),
				lastAnalysis: record({ id: "analysis-0", status: "failed", error: "The analysis model failed." }),
			}),
			{
				name: "solo",
				issues: [],
				skills: [entry],
				duplicates: [],
				canAnalyze: false,
				unavailableReason: "Only one copy is loaded; nothing to compare.",
			},
		]);
		const { client, emit } = await scriptedClient(request =>
			request.type === "get_state" ? { data: { skillDiagnostics: full } } : { data: full },
		);
		const updates: SkillDiagnosticsSnapshot[] = [];
		const received = Promise.withResolvers<void>();
		client.onSkillDiagnosticsUpdate(update => {
			updates.push(update);
			received.resolve();
		});

		const queried = await client.getSkillDiagnostics();
		expect(queried).toEqual(full as never);
		const [review, solo] = queried.items!;
		expect(review!.analysis!.result).toEqual(analysis as never);
		expect(review!.analysis!.result!.recommendation.preferredId).toBe("a");
		expect(review!.lastAnalysis).toMatchObject({ status: "failed", error: "The analysis model failed." });
		expect(solo).toMatchObject({
			canAnalyze: false,
			unavailableReason: "Only one copy is loaded; nothing to compare.",
		});
		expect(solo!.analysis).toBeUndefined();
		expect((await client.getState()).skillDiagnostics).toEqual(queried);

		emit({ type: "skill_diagnostics_update", data: full });
		await received.promise;
		expect(updates).toEqual([queried]);
	});

	test("an older server's snapshot without items still decodes and has no items", async () => {
		const { client } = await scriptedClient(request =>
			request.type === "get_state" ? { data: { skillDiagnostics: snapshot() } } : { data: snapshot() },
		);
		const queried = await client.getSkillDiagnostics();
		expect(queried).toEqual({ cwd: "/workspace", showStartupDiagnostics: true, diagnostics: [] });
		expect("items" in queried).toBe(false);
		expect("items" in (await client.getState()).skillDiagnostics!).toBe(false);
	});

	test("rejects malformed enums, ids, booleans, numbers and results", async () => {
		let payload: unknown;
		const { client } = await scriptedClient(() => ({ data: payload }));
		const withRecord = (overrides: Record<string, unknown>) => snapshot([item({ analysis: record(overrides) })]);
		const withResult = (result: unknown) => withRecord({ status: "complete", result });
		const cases: Array<[unknown, RegExp]> = [
			[snapshot([item({ issues: ["bogus"] })]), /issues\[0\] is invalid/],
			[snapshot([item({ reason: "newest-wins" })]), /reason is invalid/],
			[snapshot([item({ canAnalyze: 1 })]), /canAnalyze must be a boolean/],
			[snapshot([item({ name: 7 })]), /name must be a string/],
			[{ ...snapshot(), items: {} }, /items must be an array/],
			[withRecord({ status: "paused" }), /status is invalid/],
			[withRecord({ applied: "no" }), /applied must be a boolean/],
			[withRecord({ id: "" }), /id must not be empty/],
			[withRecord({ bytes: 1.5 }), /bytes must be a non-negative integer/],
			[withRecord({ createdAt: -1 }), /createdAt must be a non-negative integer/],
			[withRecord({ candidates: [{ ...candidate("a"), complete: "yes" }] }), /complete must be a boolean/],
			[withRecord({ candidates: [{ ...candidate("a"), omissions: [1] }] }), /omissions\[0\] must be a string/],
			[withResult({ ...analysis, relationship: "twins" }), /relationship is invalid/],
			[
				withResult({ ...analysis, recommendation: { ...analysis.recommendation, action: "hide" } }),
				/recommendation\.action is invalid/,
			],
			[withResult({ ...analysis, evidence: [{ ...analysis.evidence[0], quote: 3 }] }), /quote must be a string/],
			[withResult({ ...analysis, differences: "none" }), /differences must be an array/],
		];
		for (const [value, message] of cases) {
			payload = value;
			await expect(client.getSkillDiagnostics()).rejects.toThrow(message);
		}
		payload = withResult(analysis);
		expect((await client.getSkillDiagnostics()).items![0]!.analysis!.result).toEqual(analysis as never);
	});
});

describe("RpcClient skill diagnostic analysis commands", () => {
	test("a malformed record in a command response is an error, not a partial result", async () => {
		const { client } = await scriptedClient(() => ({ data: record({ status: "done" }) }));
		await expect(client.prepareSkillDiagnosticAnalysis("review")).rejects.toThrow(/status is invalid/);
		await expect(client.analyzeSkillDiagnostics("analysis-1", true)).rejects.toThrow(/status is invalid/);
		await expect(client.cancelSkillDiagnosticAnalysis("analysis-1")).rejects.toThrow(/status is invalid/);
		await expect(client.applySkillDiagnosticAnalysis("analysis-1", true)).rejects.toThrow(/status is invalid/);
	});
});
