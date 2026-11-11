import { type } from "@oh-my-pi/omptype";
import type { AgentToolResult, ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import type { ModelCost } from "@oh-my-pi/pi-catalog/types";
import type { ExtensionAskDialogResult } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { untilAborted } from "@oh-my-pi/pi-utils";
import type { EvalPreludeContext, EvalPreludeDefinition } from "../eval/preludes";
import { cfgRatchetEnabled } from "../tools/settings";
import ratchetDocumentation from "../prompts/tools/ratchet.md" with { type: "text" };
import type { ToolSession } from "../tools";
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import ratchetJavascript from "./prelude.js" with { type: "text" };
import ratchetPython from "./prelude.py" with { type: "text" };
import {
	applyPlan,
	approvalStatus,
	checkVariant,
	gateVariant,
	initFlow,
	type PriceLookup,
	RATCHET_STAGES,
	RatchetError,
	type RatchetStage,
	renderStatusTable,
	requireState,
	saveState,
	splitCases,
	stageDigest,
	trainView,
} from "./ratchet";

const direction = type("'higher' | 'lower'");
const price = type({
	in: "number >= 0",
	out: "number >= 0",
	"cache_read?": "number >= 0",
	"cache_write?": "number >= 0",
});
const base = { flow: "string > 0" } as const;

const paramsSchema = type({
	...base,
	action: "'init'",
	cases: "string[]",
	harness: "string[]",
	change: "string[]",
	"off_limits?": "string[]",
	"command?": "string > 0",
})
	.or({
		...base,
		action: "'plan'",
		"goal?": {
			target: "string > 0",
			"direction?": direction,
			"hold?": "string[]",
			"directions?": { "[string]": direction },
		},
		"reps?": "number.integer >= 1",
		"stop?": { "plateau?": "number.integer >= 2", "rounds?": "number.integer >= 1" },
		"command?": "string > 0",
		"prices?": { "[string]": price },
	})
	.or({
		...base,
		action: "'split'",
		cases: { "[string]": "string" },
		"test_fraction?": "0 < number < 1",
		"seed?": "number.integer >= 0",
	})
	.or({
		...base,
		action: "'approve'",
		stage: "'inputs' | 'grader' | 'plan'",
		question: "string > 0",
		preview: "string > 0",
	})
	.or({ ...base, action: "'check' | 'train'", variant: "string > 0" })
	.or({ ...base, action: "'gate'", variant: "string > 0", "change?": "string" })
	.or({ ...base, action: "'status'" });

type RatchetParams = typeof paramsSchema.infer;

/** Read-only actions never mutate flow state; everything else writes `.omp/ratchet/<flow>/`. */
export function ratchetApproval(args: unknown): ToolApprovalDecision {
	if (args === null || typeof args !== "object" || !("action" in args)) return "write";
	return args.action === "status" || args.action === "check" || args.action === "train" ? "read" : "write";
}

/**
 * Catalog-backed pricing: a served id resolves only when every registry entry
 * with that id (bare or `provider/id`) carries the same non-zero rate card. A
 * zero-cost subscription entry or a conflicting provider leaves the id
 * unpriced (surfaced as a warning) rather than guessing which rate applied.
 */
function catalogPriceLookup(session: ToolSession): PriceLookup {
	const cache = new Map<string, ModelCost | undefined>();
	return model => {
		if (cache.has(model)) return cache.get(model);
		const candidates = (session.modelRegistry?.getAll("all") ?? []).filter(
			entry => entry.id === model || `${entry.provider}/${entry.id}` === model,
		);
		const allPriced = candidates.every(entry => entry.cost.input > 0 || entry.cost.output > 0);
		const distinct = new Set(candidates.map(entry => JSON.stringify(entry.cost)));
		const resolved = candidates.length > 0 && allPriced && distinct.size === 1 ? candidates[0]!.cost : undefined;
		cache.set(model, resolved);
		return resolved;
	};
}

/**
 * Serializes read-modify-write of one flow's `_state.json` within this process,
 * so concurrent calls (e.g. two approvals) never overwrite each other's update.
 */
const flowLocks = new Map<string, Promise<unknown>>();

async function withFlowLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const previous = flowLocks.get(key) ?? Promise.resolve();
	const run = previous.then(fn, fn);
	const settled = run.then(
		() => undefined,
		() => undefined,
	);
	flowLocks.set(key, settled);
	try {
		return await run;
	} finally {
		if (flowLocks.get(key) === settled) flowLocks.delete(key);
	}
}

export type ApprovalOutcome = { approved: true } | { approved: false; aborted: boolean; feedback?: string };

/** Host-owned approval dialog: no recommended option and no timeout, so only an explicit Approve counts. */
async function askApproval(
	context: EvalPreludeContext,
	stage: RatchetStage,
	question: string,
	preview: string,
): Promise<ApprovalOutcome> {
	const toolContext = context.context;
	const ui = toolContext?.ui;
	if (!ui || toolContext?.hasUI === false) {
		throw new ToolError(
			"ratchet approvals need an interactive session; headless runs can only continue a flow whose approvals are current",
		);
	}
	const header = `ratchet · ${stage}`;
	// The reviewed material goes in the question body: every dialog surface renders it
	// (ACP forwards the question text but not per-option previews).
	const body = `${question}\n\n${preview}`;
	if (ui.askDialog) {
		const askDialog = ui.askDialog;
		const result: ExtensionAskDialogResult | undefined = await untilAborted(context.signal, () =>
			askDialog([
				{
					id: stage,
					header,
					question: body,
					options: [
						{ label: "Approve", description: "Record this approval and continue" },
						{ label: "Revise", description: "Say what to change; nothing is recorded" },
						{ label: "Abort", description: "Stop the ratchet run" },
					],
				},
			]),
		);
		if (!result) return { approved: false, aborted: true };
		if (result.kind === "chat") return { approved: false, aborted: false, feedback: "User asked to discuss first" };
		const answer = result.results[0];
		if (!answer || answer.timedOut) return { approved: false, aborted: false, feedback: "No answer before timeout" };
		const choice = answer.selectedOptions[0];
		if (choice === "Approve") return { approved: true };
		if (choice === "Abort") return { approved: false, aborted: true };
		const feedback = answer.customInput ?? answer.note ?? (await ui.input("What should change?"));
		return { approved: false, aborted: false, feedback: feedback ?? "" };
	}
	const choice = await untilAborted(context.signal, () =>
		ui.select(`${header}\n\n${body}`, ["Approve", "Revise", "Abort"]),
	);
	if (choice === "Approve") return { approved: true };
	if (choice !== "Revise") return { approved: false, aborted: true };
	return { approved: false, aborted: false, feedback: (await ui.input("What should change?")) ?? "" };
}

function result(text: string, details: unknown): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

async function invokeRatchet(
	session: ToolSession,
	params: RatchetParams,
	context: EvalPreludeContext,
	lookup: PriceLookup,
): Promise<AgentToolResult<unknown>> {
	const cwd = session.cwd;
	const lockKey = `${cwd}\0${params.flow}`;
	if (params.action === "init") {
		const state = await withFlowLock(lockKey, () => initFlow(cwd, params.flow, params));
		return result(`ratchet flow ${state.flow} ready`, state);
	}
	switch (params.action) {
		case "plan": {
			const state = await withFlowLock(lockKey, async () => {
				const fresh = await requireState(cwd, params.flow);
				applyPlan(fresh, params);
				await saveState(cwd, fresh);
				return fresh;
			});
			return result(`plan updated for ${state.flow}`, state);
		}
		case "split": {
			const state = await withFlowLock(lockKey, async () => {
				const fresh = await requireState(cwd, params.flow);
				splitCases(fresh, params.cases, params.test_fraction, params.seed);
				await saveState(cwd, fresh);
				return fresh;
			});
			return result(
				`split ${state.flow}: ${state.train_ids.length} train / ${state.test_ids.length} test (seed ${state.split_seed})`,
				{ train_ids: state.train_ids, test_ids: state.test_ids, seed: state.split_seed },
			);
		}
		case "approve": {
			const reviewed = await requireState(cwd, params.flow);
			const sha = await stageDigest(cwd, reviewed, params.stage);
			if (reviewed.approvals[params.stage]?.sha === sha) {
				return result("", { approved: true, already: true });
			}
			const outcome = await askApproval(context, params.stage, params.question, params.preview);
			if (!outcome.approved) return result("", outcome);
			// Record against freshly loaded state so approvals made meanwhile survive, and only
			// if the material is still what the user just reviewed.
			const recorded = await withFlowLock(lockKey, async (): Promise<ApprovalOutcome> => {
				const fresh = await requireState(cwd, params.flow);
				if ((await stageDigest(cwd, fresh, params.stage)) !== sha) {
					return {
						approved: false,
						aborted: false,
						feedback: "The material changed during review; approve again",
					};
				}
				fresh.approvals[params.stage] = { sha, at: new Date().toISOString() };
				await saveState(cwd, fresh);
				return outcome;
			});
			return result("", recorded);
		}
		case "check": {
			const check = await checkVariant(cwd, await requireState(cwd, params.flow), params.variant);
			return result("", check);
		}
		case "gate": {
			const gate = await withFlowLock(lockKey, async () =>
				gateVariant(cwd, await requireState(cwd, params.flow), params.variant, params.change ?? "", lookup),
			);
			const lines = [`${gate.variant}: ${gate.decision} — ${gate.reasons.join("; ")}`];
			for (const warning of gate.warnings) lines.push(`warning: ${warning}`);
			if (gate.plateau)
				lines.push("plateau reached: categorize remaining train failures before another content round");
			else if (gate.done) lines.push("round limit reached: report");
			return result(lines.join("\n"), gate);
		}
		case "train":
			return result("", await trainView(cwd, await requireState(cwd, params.flow), params.variant, lookup));
		case "status": {
			const state = await requireState(cwd, params.flow);
			const approvals = await approvalStatus(cwd, state);
			const approvalLine = RATCHET_STAGES.map(stage => `${stage}=${approvals[stage]}`).join(" ");
			return result(`${state.flow}: ${approvalLine}\n${renderStatusTable(state)}`, {
				...state,
				approval_status: approvals,
			});
		}
	}
}

/** Create the ratchet eval prelude; `/ratchet` enables it for the session via `ratchet.enabled`. */
export function createRatchetPrelude(session: ToolSession): EvalPreludeDefinition {
	const lookup = catalogPriceLookup(session);
	return {
		name: "ratchet",
		documentation: ratchetDocumentation,
		javascript: ratchetJavascript,
		python: ratchetPython,
		exports: ["ratchet"],
		approval: ratchetApproval,
		enabled: () => cfgRatchetEnabled.get(session.settings) === true,
		invoke: async (parameters, context) => {
			const parsed = paramsSchema(parameters);
			if (parsed instanceof type.errors)
				throw new ToolError(`ratchet received invalid arguments: ${parsed.summary}`);
			try {
				return await invokeRatchet(session, parsed, context, lookup);
			} catch (err) {
				if (err instanceof RatchetError) throw new ToolError(err.message);
				throw err;
			}
		},
		status: (parameters, outcome) => {
			const parsed = paramsSchema(parameters);
			if (parsed instanceof type.errors) return undefined;
			const target =
				"variant" in parsed ? `(${parsed.variant})` : parsed.action === "approve" ? `(${parsed.stage})` : "()";
			const details = outcome.details;
			const decision =
				parsed.action === "gate" && details && typeof details === "object" && "decision" in details
					? ` → ${String(details.decision)}`
					: "";
			return `ratchet("${parsed.flow}").${parsed.action}${target}${decision}`;
		},
	};
}
