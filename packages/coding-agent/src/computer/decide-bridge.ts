/**
 * Host-side handler for the eval `computer.decide()` helper.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { resolveJudge } from "../judgment";
import { ONLINE_MEMORY_MODEL_KEY } from "../tiny/models";
import type { ToolSession } from "../tools";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import {
	type ComputerCandidate,
	type ComputerDecisionPacket,
	type ComputerDecisionState,
	decideComputerStep,
	DEFAULT_MIN_CONFIDENCE,
} from "./decide";
import { shouldUseComputerJev } from "./policy";

export const EVAL_COMPUTER_DECIDE_BRIDGE_NAME = "__computer_decide__";

function invalid(detail: string): ToolError {
	return new ToolError(`computer.decide() received invalid arguments: ${detail}`);
}

function parseCandidate(value: unknown, index: number): ComputerCandidate {
	if (!isRecord(value)) throw invalid(`candidates[${index}] must be an object`);
	const id = value.id;
	const label = value.label;
	if (typeof id !== "string" || !id.trim()) throw invalid(`candidates[${index}].id must be a non-empty string`);
	if (typeof label !== "string" || !label.trim())
		throw invalid(`candidates[${index}].label must be a non-empty string`);
	return {
		id: id.trim(),
		label: label.trim(),
		role: typeof value.role === "string" ? value.role : undefined,
		region: typeof value.region === "string" ? value.region : undefined,
		source: value.source === "ax" || value.source === "ocr" || value.source === "ax+ocr" ? value.source : undefined,
	};
}

function parseState(value: unknown): ComputerDecisionState {
	if (!isRecord(value)) throw invalid("state must be an object");
	const goal = value.goal;
	if (typeof goal !== "string") throw invalid("state.goal must be a string");
	if (!Array.isArray(value.candidates)) throw invalid("state.candidates must be an array");
	const candidates = value.candidates.map(parseCandidate);
	const recent_actions = Array.isArray(value.recent_actions)
		? value.recent_actions.filter((line): line is string => typeof line === "string")
		: undefined;
	let focused_field: ComputerDecisionState["focused_field"];
	if (isRecord(value.focused_field)) {
		focused_field = {
			label: typeof value.focused_field.label === "string" ? value.focused_field.label : undefined,
			placeholder: typeof value.focused_field.placeholder === "string" ? value.focused_field.placeholder : undefined,
			value: typeof value.focused_field.value === "string" ? value.focused_field.value : undefined,
		};
	}
	return {
		goal,
		candidates,
		recent_actions,
		focused_field,
		app: typeof value.app === "string" ? value.app : undefined,
		url: typeof value.url === "string" ? value.url : undefined,
	};
}

export interface EvalComputerDecideBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
}

export interface EvalComputerDecideResult {
	text: string;
	data: ComputerDecisionPacket | null;
	details: { backend: string; latencyMs: number; jev: boolean };
}

export async function runEvalComputerDecide(
	args: unknown,
	options: EvalComputerDecideBridgeOptions,
): Promise<EvalComputerDecideResult> {
	if (!isRecord(args)) throw invalid("expected { state, minConfidence? }");
	const state = parseState(args.state);
	const minConfidence =
		typeof args.minConfidence === "number" && Number.isFinite(args.minConfidence)
			? args.minConfidence
			: DEFAULT_MIN_CONFIDENCE;

	const { session } = options;
	const registry = session.modelRegistry as ModelRegistry | undefined;
	const settings = session.settings as Settings | undefined;
	if (!registry || !settings) throw new ToolError("computer.decide() has no session registry.");

	const useJev = shouldUseComputerJev(settings, registry);
	const judge = useJev
		? resolveJudge({
				settings,
				registry,
				backend: ONLINE_MEMORY_MODEL_KEY,
				sessionId: session.getSessionId?.() ?? undefined,
			})
		: undefined;

	const packet = await decideComputerStep({
		state,
		judge,
		useJev,
		signal: options.signal,
		minConfidence,
	});

	return {
		text: JSON.stringify(packet),
		data: packet,
		details: {
			backend: packet?.backend ?? "none",
			latencyMs: packet?.latencyMs ?? 0,
			jev: useJev,
		},
	};
}
