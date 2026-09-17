import type { ComputerDecision, ComputerDecisionBackend } from "../computer/decide";

export interface ComputerDecideTask {
	id: string;
	goal: string;
	candidates: Array<{ id: string; label: string; role?: string; source?: "ax" | "ocr" | "ax+ocr" }>;
	expected: {
		action?: string;
		target?: string;
		backend?: string;
		null?: boolean;
		minConfidence?: number;
	};
	gtkLabels?: string;
}

export interface ComputerDecideResultRow {
	task: string;
	arm: string;
	ok: boolean;
	latencyMs: number;
	backend?: ComputerDecisionBackend;
	action?: string;
	target?: string;
	error?: string;
}

export function gradeComputerDecideTask(task: ComputerDecideTask, decision: ComputerDecision | null): boolean {
	const exp = task.expected;
	if (exp.null) return decision === null;
	if (!decision) return false;
	if (exp.action !== undefined && decision.action !== exp.action) return false;
	if (exp.target !== undefined && decision.target !== exp.target) return false;
	if (exp.backend !== undefined) {
		const allowed = exp.backend.split("|");
		if (!allowed.includes(decision.backend)) return false;
	}
	if (exp.minConfidence !== undefined && decision.confidence < exp.minConfidence) return false;
	return true;
}
