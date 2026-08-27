import delegatedBoundaryPrompt from "../prompts/system/vibe-delegated-worker-boundary.md" with { type: "text" };

export const VIBE_DELEGATED_WORKER_BOUNDARY = delegatedBoundaryPrompt.trim();
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEPENDENCY_KEYS = [
	"args",
	"dependent_artifact",
	"dependent_gate",
	"execution_owner",
	"reason",
	"skill",
	"status",
	"type",
];
const RESULT_KEYS = ["evidence", "skill", "status", "type"];

export interface DelegatedSkillDependency {
	type: "dependency_required";
	skill: string;
	args: string;
	execution_owner: "parent_active_session";
	status: "not_run";
	reason: "delegated_worker_boundary";
	dependent_gate: string;
	dependent_artifact: string;
}
export interface SkillDispatchResult {
	type: "skill-dispatch-result/v1";
	skill: string;
	status: "success" | "partial" | "failed";
	evidence: string;
	correlationId?: string;
}

function hasExactKeys(value: object, keys: string[]): boolean {
	return Object.keys(value).sort().join("\0") === keys.slice().sort().join("\0");
}

export function buildVibeDelegatedAssignment(message: string): string {
	return `${VIBE_DELEGATED_WORKER_BOUNDARY}\n\nAssignment:\n${message}`;
}
export function parseDelegatedSkillDependency(value: string): DelegatedSkillDependency | null {
	try {
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !hasExactKeys(parsed, DEPENDENCY_KEYS))
			return null;
		const candidate = parsed as Record<string, unknown>;
		const skill = typeof candidate.skill === "string" ? candidate.skill.trim() : "";
		const args = typeof candidate.args === "string" ? candidate.args : "";
		const gate = typeof candidate.dependent_gate === "string" ? candidate.dependent_gate.trim() : "";
		const artifact = typeof candidate.dependent_artifact === "string" ? candidate.dependent_artifact.trim() : "";
		if (
			!SKILL_NAME_PATTERN.test(skill) ||
			skill !== candidate.skill ||
			args.length > 2048 ||
			/[\0\r\n]/.test(args) ||
			args.trimStart().startsWith("/") ||
			!gate ||
			gate.length > 256 ||
			!artifact ||
			artifact.length > 512
		)
			return null;
		if (
			candidate.type !== "dependency_required" ||
			candidate.execution_owner !== "parent_active_session" ||
			candidate.status !== "not_run" ||
			candidate.reason !== "delegated_worker_boundary"
		)
			return null;
		return {
			type: "dependency_required",
			skill,
			args,
			execution_owner: "parent_active_session",
			status: "not_run",
			reason: "delegated_worker_boundary",
			dependent_gate: gate,
			dependent_artifact: artifact,
		};
	} catch {
		return null;
	}
}
export function validateSkillDispatchResult(
	value: unknown,
	skill: string,
	correlationId?: string,
): SkillDispatchResult | null {
	const hasCorrelation = value && typeof value === "object" && "correlationId" in value;
	if (
		!value ||
		typeof value !== "object" ||
		(!hasCorrelation && correlationId !== undefined) ||
		(hasCorrelation && !hasExactKeys(value, [...RESULT_KEYS, "correlationId"])) ||
		(!hasCorrelation && !hasExactKeys(value, RESULT_KEYS))
	)
		return null;
	const result = value as Record<string, unknown>;
	if (
		result.type !== "skill-dispatch-result/v1" ||
		result.skill !== skill ||
		!["success", "partial", "failed"].includes(String(result.status)) ||
		typeof result.evidence !== "string" ||
		!result.evidence.trim() ||
		result.evidence.length > 8192 ||
		(hasCorrelation &&
			(typeof result.correlationId !== "string" ||
				!result.correlationId ||
				result.correlationId.length > 256 ||
				/[\0\r\n]/.test(result.correlationId)))
	)
		return null;
	if (correlationId !== undefined && result.correlationId !== correlationId) return null;
	return result as unknown as SkillDispatchResult;
}

export async function coordinateDelegatedSkillDependency(
	output: string,
	dispatch: (dependency: DelegatedSkillDependency) => Promise<unknown>,
	resume: (payload: SkillDispatchResult) => Promise<void>,
	cache: Map<string, Promise<SkillDispatchResult | null>>,
	fingerprintPrefix = "",
	expectedCorrelation?: string,
): Promise<{ handled: boolean; result: SkillDispatchResult | null }> {
	const dependency = parseDelegatedSkillDependency(output.trim());
	if (!dependency) return { handled: false, result: null };
	const key = `${fingerprintPrefix}:${JSON.stringify([dependency.skill, dependency.args, dependency.dependent_gate, dependency.dependent_artifact])}`;
	let pending = cache.get(key);
	if (!pending) {
		pending = (async () => {
			const result = validateSkillDispatchResult(await dispatch(dependency), dependency.skill, expectedCorrelation);
			if (result?.status === "success") await resume(result);
			return result;
		})();
		cache.set(key, pending);
	}
	return { handled: true, result: await pending };
}
