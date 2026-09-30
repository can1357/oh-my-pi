import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval";
import { type ApprovalOutcome, createRatchetPrelude } from "@oh-my-pi/pi-coding-agent/ratchet/prelude";
import type { ApprovalStatus, GateResult, RatchetState } from "@oh-my-pi/pi-coding-agent/ratchet/ratchet";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { ExtensionAskDialogQuestion, ExtensionAskDialogResult } from "@oh-my-pi/pi-tui/overlays/ask-dialog";

const FLOW = "router";
const CASES = Array.from({ length: 10 }, (_, index) => `case_${index}`);

type Answer = "Approve" | "Revise" | "timeout";
type Status = RatchetState & { approval_status: ApprovalStatus };
type Row = Record<string, unknown>;

interface Harness {
	prelude: EvalPreludeDefinition;
	call<T>(params: Record<string, unknown>, answer?: Answer): Promise<T>;
	approve(stage: string, answer?: Answer): Promise<ApprovalOutcome>;
	gate(variant: string, change?: string): Promise<GateResult>;
	writeRows(variant: string, grade: (id: string) => number, extra?: (id: string) => Row): Promise<void>;
	split: { train_ids: string[]; test_ids: string[] };
	questions: ExtensionAskDialogQuestion[];
}

let root: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ratchet-"));
	await Bun.write(path.join(root, "eval/cases.jsonl"), CASES.map(id => JSON.stringify({ id })).join("\n"));
	await Bun.write(path.join(root, "eval/run.ts"), "// runner\n");
	await Bun.write(path.join(root, "src/prompt.md"), "route emails\n");
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

const flowPath = (...parts: string[]) => path.join(root, ".omp/ratchet", FLOW, ...parts);

async function setup(options: { hold?: string[]; models?: unknown[] } = {}): Promise<Harness> {
	const session = {
		cwd: root,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		modelRegistry: { getAll: () => options.models ?? [] },
	} as unknown as ToolSession;
	const prelude = createRatchetPrelude(session);
	const questions: ExtensionAskDialogQuestion[] = [];
	const askDialog = (answer: Answer) => async (asked: ExtensionAskDialogQuestion[]) => {
		questions.push(...asked);
		const result: ExtensionAskDialogResult = {
			kind: "submit",
			results: [
				{
					id: asked[0]!.id,
					question: asked[0]!.question,
					options: ["Approve", "Revise", "Abort"],
					multi: false,
					selectedOptions: answer === "timeout" ? ["Approve"] : [answer],
					customInput: answer === "Revise" ? "drop case_3" : undefined,
					timedOut: answer === "timeout",
				},
			],
		};
		return result;
	};
	const call = async <T>(params: Record<string, unknown>, answer: Answer = "Approve"): Promise<T> => {
		const context = {
			hasUI: true,
			ui: { askDialog: askDialog(answer), input: async () => "typed" },
		} as unknown as AgentToolContext;
		const result = await prelude.invoke({ flow: FLOW, ...params }, { session, toolCallId: "t", context });
		return result.details as T;
	};
	await call({ action: "init", cases: ["eval/cases.jsonl"], harness: ["eval/run.ts"], change: ["src/prompt.md"] });
	await call({
		action: "plan",
		goal: { target: "quality", hold: options.hold ?? [] },
		reps: 1,
		command: "bun eval/run.ts --variant {variant}",
	});
	const split = await call<Harness["split"]>({
		action: "split",
		cases: Object.fromEntries(CASES.map(id => [id, "billing"])),
		seed: 7,
	});
	return {
		prelude,
		call,
		approve: (stage, answer) =>
			call<ApprovalOutcome>({ action: "approve", stage, question: "ok?", preview: `${stage} table` }, answer),
		gate: (variant, change) =>
			call<GateResult>(change === undefined ? { action: "gate", variant } : { action: "gate", variant, change }),
		writeRows: async (variant, grade, extra) => {
			const rows = CASES.map(id =>
				JSON.stringify({ prompt_id: id, rep: 0, grade: { quality: grade(id) }, ...extra?.(id) }),
			);
			await Bun.write(flowPath(variant, "results.jsonl"), `${rows.join("\n")}\n`);
		},
		split,
		questions,
	};
}

async function approveAll(harness: Harness): Promise<void> {
	for (const stage of ["inputs", "grader", "plan"]) {
		expect((await harness.approve(stage)).approved).toBe(true);
	}
}

describe("ratchet gate", () => {
	it("keeps a change only when train and test both improve, and reverts a train-only gain as overfit", async () => {
		const harness = await setup();
		await approveAll(harness);
		const train = new Set(harness.split.train_ids);

		await harness.writeRows("baseline", () => 0.2);
		expect((await harness.gate("baseline")).decision).toBe("baseline");

		await harness.writeRows("v1", () => 0.5);
		const kept = await harness.gate("v1", "define each queue");
		expect(kept.decision).toBe("keep");
		expect(kept.best?.variant).toBe("v1");

		await harness.writeRows("v2", id => (train.has(id) ? 0.9 : 0.5));
		const overfit = await harness.gate("v2", "quote failing emails");
		expect(overfit.decision).toBe("revert");
		expect(overfit.reasons.join(" ")).toContain("overfit");
		expect(overfit.best?.variant).toBe("v1");
	});

	it("reverts a target gain that regresses a guardrail", async () => {
		const harness = await setup({ hold: ["cost_usd"] });
		await approveAll(harness);
		await harness.writeRows(
			"baseline",
			() => 0.2,
			() => ({ cost_usd: 0.01 }),
		);
		await harness.gate("baseline");
		await harness.writeRows(
			"v1",
			() => 0.6,
			() => ({ cost_usd: 0.05 }),
		);
		const gate = await harness.gate("v1", "switch to bigger model");
		expect(gate.decision).toBe("revert");
		expect(gate.reasons.join(" ")).toContain("cost_usd");
	});

	it("refuses to gate when a guardrail cannot be measured", async () => {
		const harness = await setup({ hold: ["cost_usd"] });
		await approveAll(harness);
		await harness.writeRows(
			"baseline",
			() => 0.2,
			() => ({ cost_usd: 0.01 }),
		);
		await harness.gate("baseline");
		// A new model the catalog cannot price: quality rises, cost is unknown.
		await harness.writeRows(
			"v1",
			() => 0.9,
			() => ({ model: "mystery-model", usage: { input_tokens: 100 } }),
		);
		await expect(harness.gate("v1", "new model")).rejects.toThrow(/Guardrail cost_usd/);
	});

	it("does not keep a round whose slots only errored", async () => {
		const harness = await setup();
		await approveAll(harness);
		await harness.writeRows("baseline", () => 0.2);
		await harness.gate("baseline");
		const hard = harness.split.test_ids[0]!;
		const rows = CASES.filter(id => id !== hard).map(id =>
			JSON.stringify({ prompt_id: id, rep: 0, grade: { quality: 0.9 } }),
		);
		await Bun.write(flowPath("v1", "results.jsonl"), rows.join("\n"));
		await Bun.write(flowPath("v1", "errors.jsonl"), JSON.stringify({ prompt_id: hard, rep: 0, class: "timeout" }));
		const gate = await harness.gate("v1", "shorter prompt");
		expect(gate.decision).toBe("rerun");
		expect(gate.best?.variant).toBe("baseline");
	});

	it("refuses duplicate result rows for one slot", async () => {
		const harness = await setup();
		await approveAll(harness);
		await harness.writeRows("baseline", () => 0.2);
		const extra = JSON.stringify({ prompt_id: CASES[0], rep: 0, grade: { quality: 1 } });
		await fs.appendFile(flowPath("baseline", "results.jsonl"), `${extra}\n`);
		await expect(harness.gate("baseline")).rejects.toThrow(/duplicate/);
	});

	it("refuses to gate a run that wrote transcripts for held-out cases", async () => {
		const harness = await setup();
		await approveAll(harness);
		await harness.writeRows("baseline", () => 0.2);
		await Bun.write(flowPath("baseline", "traces", `${harness.split.test_ids[0]}_rep0.json`), "[]");
		await expect(harness.gate("baseline")).rejects.toThrow(/test cases/);
	});

	it("refuses to gate an incomplete run", async () => {
		const harness = await setup();
		await approveAll(harness);
		await Bun.write(
			flowPath("baseline", "results.jsonl"),
			JSON.stringify({ prompt_id: CASES[0], rep: 0, grade: { quality: 1 } }),
		);
		await expect(harness.gate("baseline")).rejects.toThrow(/incomplete/);
	});
});

describe("ratchet approvals", () => {
	it("marks the grader approval stale when the harness changes after approval", async () => {
		const harness = await setup();
		await approveAll(harness);
		await Bun.write(path.join(root, "eval/run.ts"), "// runner that now reads the answer key\n");
		const status = await harness.call<Status>({ action: "status" });
		expect(status.approval_status).toEqual({ inputs: "current", grader: "stale", plan: "current" });
		await expect(harness.call({ action: "check", variant: "baseline" })).rejects.toThrow(/grader: stale/);
	});

	it("marks the plan approval stale when price overrides change", async () => {
		const harness = await setup();
		await approveAll(harness);
		await harness.call({ action: "plan", prices: { "my-model": { in: 0.01, out: 0.01 } } });
		expect((await harness.call<Status>({ action: "status" })).approval_status.plan).toBe("stale");
	});

	it("requires a new flow when the cases change after the baseline, even if re-approved", async () => {
		const harness = await setup();
		await approveAll(harness);
		await harness.writeRows("baseline", () => 0.2);
		await harness.gate("baseline");
		await fs.appendFile(path.join(root, "eval/cases.jsonl"), `\n${JSON.stringify({ id: "case_new" })}`);
		expect((await harness.approve("inputs")).approved).toBe(true);
		await expect(harness.call({ action: "check", variant: "v1" })).rejects.toThrow(/cases changed/);
	});

	it("keeps both approvals when two stages are approved concurrently", async () => {
		const harness = await setup();
		await Promise.all([harness.approve("inputs"), harness.approve("grader")]);
		const status = await harness.call<Status>({ action: "status" });
		expect(status.approval_status.inputs).toBe("current");
		expect(status.approval_status.grader).toBe("current");
	});

	it("shows the reviewed material in the question text, not only in option previews", async () => {
		const harness = await setup();
		await harness.approve("inputs");
		expect(harness.questions[0]!.question).toContain("inputs table");
	});

	it("does not record an approval from a timed-out or revised answer", async () => {
		const harness = await setup();
		expect(await harness.approve("inputs", "timeout")).toMatchObject({ approved: false });
		expect(await harness.approve("inputs", "Revise")).toEqual({
			approved: false,
			aborted: false,
			feedback: "drop case_3",
		});
		expect((await harness.call<Status>({ action: "status" })).approval_status.inputs).toBe("missing");
	});

	it("rejects approval without an interactive UI", async () => {
		const harness = await setup();
		await expect(
			harness.prelude.invoke(
				{ flow: FLOW, action: "approve", stage: "inputs", question: "ok?", preview: "t" },
				{ session: {} as ToolSession, toolCallId: "t", context: { hasUI: false } as unknown as AgentToolContext },
			),
		).rejects.toThrow(/interactive session/);
	});
});

describe("ratchet plan, split, and cost", () => {
	it("keeps the round cap when only the plateau is updated", async () => {
		const harness = await setup();
		await harness.call({ action: "plan", stop: { rounds: 8 } });
		const state = await harness.call<RatchetState>({ action: "plan", stop: { plateau: 4 } });
		expect(state.stop).toEqual({ plateau: 4, rounds: 8 });
	});

	it("freezes the split once the baseline is gated", async () => {
		const harness = await setup();
		await approveAll(harness);
		await harness.writeRows("baseline", () => 0.2);
		await harness.gate("baseline");
		await expect(
			harness.call({ action: "split", cases: Object.fromEntries(CASES.map(id => [id, "x"])), seed: 1 }),
		).rejects.toThrow(/frozen/);
	});

	it("prices rows from the catalog and leaves unknown or subscription-shared ids unpriced", async () => {
		const known = { input: 10, output: 20, cacheRead: 1, cacheWrite: 12.5 };
		const models = [
			{ id: "known-model", provider: "p", cost: known },
			{ id: "shared-model", provider: "paid", cost: known },
			{ id: "shared-model", provider: "subscription", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
		];
		const harness = await setup({ models });
		await approveAll(harness);
		const modelFor = (id: string) =>
			id === CASES[0] ? "mystery-model" : id === CASES[1] ? "shared-model" : "known-model";
		await harness.writeRows(
			"baseline",
			() => 0.2,
			id => ({ model: modelFor(id), usage: { input_tokens: 1000, output_tokens: 500 } }),
		);
		const gate = await harness.gate("baseline");
		// 1000 in × $10/MTok + 500 out × $20/MTok = $0.02 per priced case.
		expect(gate.table.split("\n")[2]).toContain("0.0200");
		expect(gate.warnings.join(" ")).toContain("mystery-model");
		expect(gate.warnings.join(" ")).toContain("shared-model");
	});
});
