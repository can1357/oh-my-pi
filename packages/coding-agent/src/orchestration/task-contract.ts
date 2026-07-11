/**
 * Root-level task contract for substantial work on the main agent.
 * Ephemeral injection — not a permanent system-prompt dump.
 */

export const TASK_CONTRACT_VERSION = "task-contract/v1" as const;

export type TaskContractVersion = typeof TASK_CONTRACT_VERSION;

export interface TaskCriterion {
	readonly id: string;
	readonly description: string;
}

export interface TaskFailureMode {
	readonly id: string;
	readonly description: string;
}

export interface TaskEvidenceRequirement {
	readonly id: string;
	readonly description: string;
}

export interface TaskAssumption {
	readonly id: string;
	readonly statement: string;
	readonly verified?: boolean;
}

export interface VerificationPolicy {
	readonly requireTargetedChecks: boolean;
	readonly allowNarrativeOnly: boolean;
}

export interface SearchBudget {
	readonly maxInitialFamilies: number;
	readonly maxRounds: number;
	readonly maxSameBlockerRetries: number;
	readonly minEvidenceGainToContinue: number;
}

export interface OrchestrationPolicy {
	readonly maxInitialFamilies?: number;
	readonly preferIndependence?: boolean;
	readonly searchBudget?: SearchBudget;
}

export interface TaskContractV1 {
	readonly version: TaskContractVersion;
	readonly objective: string;
	readonly deliverables: readonly string[];
	readonly completionCriteria: readonly TaskCriterion[];
	readonly nonSolutions: readonly string[];
	readonly knownFailureModes: readonly TaskFailureMode[];
	readonly evidenceRequirements: readonly TaskEvidenceRequirement[];
	readonly constraints: readonly string[];
	readonly assumptions: readonly TaskAssumption[];
	readonly verificationPolicy: VerificationPolicy;
	readonly orchestrationPolicy: OrchestrationPolicy;
}

/** Compact snapshot for advisor injection and completion gates. */
export interface ActiveTaskContractSnapshot {
	readonly objective: string;
	readonly completionCriteria: readonly TaskCriterion[];
	readonly nonSolutions: readonly string[];
	readonly knownFailureModes: readonly TaskFailureMode[];
	readonly deliverables: readonly string[];
}

export interface TaskContractDiagnostic {
	readonly code: string;
	readonly message: string;
	readonly path?: string;
}

export type ParseTaskContractResult =
	| { ok: true; contract: TaskContractV1 }
	| { ok: false; diagnostics: readonly TaskContractDiagnostic[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

function parseCriteria(value: unknown, path: string, diagnostics: TaskContractDiagnostic[]): TaskCriterion[] {
	if (!Array.isArray(value)) {
		diagnostics.push({ code: "invalid_field", message: `${path} must be an array`, path });
		return [];
	}
	const out: TaskCriterion[] = [];
	for (let i = 0; i < value.length; i++) {
		const item = value[i];
		const itemPath = `${path}[${i}]`;
		if (!isPlainObject(item)) continue;
		const id = typeof item.id === "string" ? item.id.trim() : "";
		const description = typeof item.description === "string" ? item.description.trim() : "";
		if (!id || !description) {
			diagnostics.push({
				code: "missing_field",
				message: `${itemPath} requires id and description`,
				path: itemPath,
			});
			continue;
		}
		out.push({ id, description });
	}
	return out;
}

function parseFailureModes(value: unknown, path: string, diagnostics: TaskContractDiagnostic[]): TaskFailureMode[] {
	if (value === undefined) return [];
	return parseCriteria(value, path, diagnostics).map(item => ({ id: item.id, description: item.description }));
}

function parseVerificationPolicy(value: unknown): VerificationPolicy {
	if (!isPlainObject(value)) {
		return { requireTargetedChecks: true, allowNarrativeOnly: false };
	}
	return {
		requireTargetedChecks: value.requireTargetedChecks !== false,
		allowNarrativeOnly: value.allowNarrativeOnly === true,
	};
}

function parseSearchBudget(value: unknown): SearchBudget | undefined {
	if (!isPlainObject(value)) return undefined;
	const maxInitialFamilies = typeof value.maxInitialFamilies === "number" ? value.maxInitialFamilies : 5;
	const maxRounds = typeof value.maxRounds === "number" ? value.maxRounds : 3;
	const maxSameBlockerRetries = typeof value.maxSameBlockerRetries === "number" ? value.maxSameBlockerRetries : 1;
	const minEvidenceGainToContinue =
		typeof value.minEvidenceGainToContinue === "number" ? value.minEvidenceGainToContinue : 0.1;
	return Object.freeze({ maxInitialFamilies, maxRounds, maxSameBlockerRetries, minEvidenceGainToContinue });
}

function parseOrchestrationPolicy(value: unknown): OrchestrationPolicy {
	if (!isPlainObject(value)) return { preferIndependence: true };
	return {
		maxInitialFamilies: typeof value.maxInitialFamilies === "number" ? value.maxInitialFamilies : undefined,
		preferIndependence: value.preferIndependence !== false,
		searchBudget: parseSearchBudget(value.searchBudget),
	};
}

export function parseTaskContract(input: unknown): ParseTaskContractResult {
	const diagnostics: TaskContractDiagnostic[] = [];
	if (!isPlainObject(input)) {
		return { ok: false, diagnostics: [{ code: "invalid_type", message: "Task contract must be an object" }] };
	}
	if (input.version !== TASK_CONTRACT_VERSION) {
		diagnostics.push({
			code: "invalid_version",
			message: `Expected version ${TASK_CONTRACT_VERSION}`,
			path: "version",
		});
	}
	const objective = typeof input.objective === "string" ? input.objective.trim() : "";
	if (!objective) {
		diagnostics.push({ code: "missing_field", message: "objective is required", path: "objective" });
	}
	if (!isStringArray(input.deliverables)) {
		diagnostics.push({ code: "invalid_field", message: "deliverables must be a string array", path: "deliverables" });
	}
	const completionCriteria = parseCriteria(input.completionCriteria, "completionCriteria", diagnostics);
	if (completionCriteria.length === 0) {
		diagnostics.push({
			code: "empty_value",
			message: "completionCriteria must include at least one criterion",
			path: "completionCriteria",
		});
	}
	const nonSolutions = isStringArray(input.nonSolutions) ? input.nonSolutions : [];
	const knownFailureModes = parseFailureModes(input.knownFailureModes, "knownFailureModes", diagnostics);
	const evidenceRequirements =
		input.evidenceRequirements === undefined
			? []
			: parseCriteria(input.evidenceRequirements, "evidenceRequirements", diagnostics).map(item => ({
					id: item.id,
					description: item.description,
				}));
	const constraints = isStringArray(input.constraints) ? input.constraints : [];
	const assumptions: TaskAssumption[] = [];
	if (Array.isArray(input.assumptions)) {
		for (let i = 0; i < input.assumptions.length; i++) {
			const item = input.assumptions[i];
			if (!isPlainObject(item)) continue;
			const id = typeof item.id === "string" ? item.id.trim() : "";
			const statement = typeof item.statement === "string" ? item.statement.trim() : "";
			if (id && statement) {
				assumptions.push({
					id,
					statement,
					verified: typeof item.verified === "boolean" ? item.verified : undefined,
				});
			}
		}
	}

	if (diagnostics.length > 0 || !objective || !isStringArray(input.deliverables)) {
		return { ok: false, diagnostics };
	}

	return {
		ok: true,
		contract: Object.freeze({
			version: TASK_CONTRACT_VERSION,
			objective,
			deliverables: Object.freeze([...input.deliverables]),
			completionCriteria: Object.freeze(completionCriteria.map(c => Object.freeze({ ...c }))),
			nonSolutions: Object.freeze([...nonSolutions]),
			knownFailureModes: Object.freeze(knownFailureModes.map(f => Object.freeze({ ...f }))),
			evidenceRequirements: Object.freeze(evidenceRequirements.map(e => Object.freeze({ ...e }))),
			constraints: Object.freeze([...constraints]),
			assumptions: Object.freeze(assumptions.map(a => Object.freeze({ ...a }))),
			verificationPolicy: Object.freeze(parseVerificationPolicy(input.verificationPolicy)),
			orchestrationPolicy: Object.freeze(parseOrchestrationPolicy(input.orchestrationPolicy)),
		}),
	};
}

export function toActiveTaskContractSnapshot(contract: TaskContractV1): ActiveTaskContractSnapshot {
	return Object.freeze({
		objective: contract.objective,
		completionCriteria: contract.completionCriteria,
		nonSolutions: contract.nonSolutions,
		knownFailureModes: contract.knownFailureModes,
		deliverables: contract.deliverables,
	});
}

export function snapshotFromAssignmentFields(fields: {
	readonly objective: string;
	readonly deliverables: readonly string[];
	readonly nonSolutions?: readonly string[];
	readonly failureModes?: readonly { readonly id: string; readonly description: string }[];
	readonly acceptance?: readonly { readonly id: string; readonly description: string }[];
}): ActiveTaskContractSnapshot {
	return Object.freeze({
		objective: fields.objective,
		deliverables: Object.freeze([...fields.deliverables]),
		completionCriteria: Object.freeze(
			(fields.acceptance ?? []).map(c => Object.freeze({ id: c.id, description: c.description })),
		),
		nonSolutions: Object.freeze([...(fields.nonSolutions ?? [])]),
		knownFailureModes: Object.freeze(
			(fields.failureModes ?? []).map(f => Object.freeze({ id: f.id, description: f.description })),
		),
	});
}

export function formatTaskContractXmlBlock(contract: ActiveTaskContractSnapshot): string {
	const criteria = contract.completionCriteria
		.map(c => `  <criterion id="${escapeXml(c.id)}">${escapeXml(c.description)}</criterion>`)
		.join("\n");
	const nonSolutions = contract.nonSolutions.map(n => `  <item>${escapeXml(n)}</item>`).join("\n");
	const failureModes = contract.knownFailureModes
		.map(f => `  <failure-mode id="${escapeXml(f.id)}">${escapeXml(f.description)}</failure-mode>`)
		.join("\n");
	const deliverables = contract.deliverables.map(d => `  <item>${escapeXml(d)}</item>`).join("\n");

	return [
		`<active-task-contract>`,
		`  <objective>${escapeXml(contract.objective)}</objective>`,
		deliverables ? `  <deliverables>\n${deliverables}\n  </deliverables>` : "",
		criteria ? `  <completion-criteria>\n${criteria}\n  </completion-criteria>` : "",
		nonSolutions ? `  <non-solutions>\n${nonSolutions}\n  </non-solutions>` : "",
		failureModes ? `  <known-failure-modes>\n${failureModes}\n  </known-failure-modes>` : "",
		`</active-task-contract>`,
	]
		.filter(Boolean)
		.join("\n");
}

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Generic OMPK defaults applied when the compiler cannot derive specific criteria. */
const OMPK_DEFAULT_CRITERIA: readonly TaskCriterion[] = Object.freeze([
	Object.freeze({
		id: "targeted_verification",
		description:
			"All material claims are verified with targeted checks (tests, commands, reads), not narrative assertion alone",
	}),
	Object.freeze({
		id: "deliverables_present",
		description: "All promised deliverables exist and are functional in the workspace",
	}),
]);

const OMPK_DEFAULT_NON_SOLUTIONS: readonly string[] = Object.freeze([
	"Claiming completion without concrete verification",
	"Producing output that does not address the stated objective",
]);

const OMPK_DEFAULT_FAILURE_MODES: readonly TaskFailureMode[] = Object.freeze([
	Object.freeze({ id: "narrative_only", description: "Reporting done without any concrete checks or evidence" }),
	Object.freeze({ id: "scope_drift", description: "Addressing a different problem than the one requested" }),
]);

const OMPK_DEFAULT_EVIDENCE_REQUIREMENTS: readonly TaskEvidenceRequirement[] = Object.freeze([
	Object.freeze({
		id: "concrete_checks",
		description:
			"At least one concrete check (test run, command output, file read) supporting the primary deliverable",
	}),
]);

/**
 * Keywords that mark a user message as substantial enough to warrant a root task contract.
 * Trivial one-liners or conversational turns are skipped.
 */
const SUBSTANTIAL_KEYWORDS: readonly string[] = Object.freeze([
	"implement",
	"build",
	"create",
	"add",
	"refactor",
	"fix",
	"debug",
	"investigate",
	"analyze",
	"analyse",
	"design",
	"security",
	"research",
	"optimize",
	"optimise",
	"migrate",
	"integrate",
	"test",
	"deploy",
	"configure",
	"setup",
	"rewrite",
	"extend",
	"update",
	"wire",
	"enforce",
	"audit",
	"review",
	"diagnose",
]);

/**
 * Classify whether a user request is substantial enough to warrant a root TaskContractV1.
 *
 * Heuristic: multi-line, long, or action-keyword-bearing requests qualify. Conversational
 * one-liners (questions, greetings, simple lookups) do not.
 */
export function isSubstantialRequest(userText: string): boolean {
	const trimmed = userText.trim();
	if (!trimmed) return false;
	// Multi-line requests always qualify
	if (trimmed.split("\n").filter(l => l.trim()).length > 2) return true;
	// Long requests qualify
	if (trimmed.length > 200) return true;
	const lower = trimmed.toLowerCase();
	return SUBSTANTIAL_KEYWORDS.some(kw => lower.includes(kw));
}

function extractObjective(userText: string): string {
	const lines = userText
		.split("\n")
		.map(l => l.trim())
		.filter(Boolean);
	// Use first 2 non-empty lines as the objective summary
	const head = lines.slice(0, 2).join(" ");
	if (head.length <= 300) return head;
	return `${head.slice(0, 297)}…`;
}

export interface CompileTaskContractOptions {
	readonly constraints?: readonly string[];
	readonly nonSolutions?: readonly string[];
	readonly maxInitialFamilies?: number;
}

/**
 * Compile a TaskContractV1 from a user request using OMPK generic defaults.
 *
 * Fills objective from the request text; uses built-in defaults for criteria and
 * failure modes that apply to any substantial coding task. Callers can supply
 * additional constraints and non-solutions.
 */
export function compileTaskContractFromRequest(userText: string, options?: CompileTaskContractOptions): TaskContractV1 {
	const objective = extractObjective(userText);
	const nonSolutions = options?.nonSolutions?.length
		? [...OMPK_DEFAULT_NON_SOLUTIONS, ...options.nonSolutions]
		: [...OMPK_DEFAULT_NON_SOLUTIONS];

	return Object.freeze({
		version: TASK_CONTRACT_VERSION,
		objective,
		deliverables: Object.freeze([] as string[]),
		completionCriteria: OMPK_DEFAULT_CRITERIA,
		nonSolutions: Object.freeze(nonSolutions),
		knownFailureModes: OMPK_DEFAULT_FAILURE_MODES,
		evidenceRequirements: OMPK_DEFAULT_EVIDENCE_REQUIREMENTS,
		constraints: Object.freeze([...(options?.constraints ?? [])]),
		assumptions: Object.freeze([] as TaskAssumption[]),
		verificationPolicy: Object.freeze({ requireTargetedChecks: true, allowNarrativeOnly: false }),
		orchestrationPolicy: Object.freeze({
			preferIndependence: true,
			maxInitialFamilies: options?.maxInitialFamilies,
		}),
	});
}

/**
 * Format a TaskContractV1 as a root-level `<task-contract>` XML block for ephemeral
 * injection into the primary agent system prompt.
 *
 * Distinct from `formatTaskContractXmlBlock` (which uses `<active-task-contract>` for
 * advisor injection).
 */
export function formatRootTaskContractXml(contract: TaskContractV1): string {
	const criteria = contract.completionCriteria
		.map(c => `  <criterion id="${escapeXml(c.id)}">${escapeXml(c.description)}</criterion>`)
		.join("\n");
	const nonSolutions = contract.nonSolutions.map(n => `  <item>${escapeXml(n)}</item>`).join("\n");
	const failureModes = contract.knownFailureModes
		.map(f => `  <failure-mode id="${escapeXml(f.id)}">${escapeXml(f.description)}</failure-mode>`)
		.join("\n");

	return [
		`<task-contract version="${TASK_CONTRACT_VERSION}">`,
		`  <objective>${escapeXml(contract.objective)}</objective>`,
		criteria ? `  <completion-criteria>\n${criteria}\n  </completion-criteria>` : "",
		nonSolutions ? `  <non-solutions>\n${nonSolutions}\n  </non-solutions>` : "",
		failureModes ? `  <known-failure-modes>\n${failureModes}\n  </known-failure-modes>` : "",
		`</task-contract>`,
	]
		.filter(Boolean)
		.join("\n");
}
