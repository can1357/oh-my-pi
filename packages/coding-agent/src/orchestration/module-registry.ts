/**
 * Fixed versioned reasoning-module registry.
 *
 * Each entry defines a module family, a module ID within that family, and the
 * constraints under which it may be selected. The selector chooses the smallest
 * set of modules that covers all required deliverables, criteria, risks, and
 * independent verification needs.
 *
 * Do not add modules that have no clear criterion, artifact, or risk connection.
 */

import type { EstimatedMagnitude, WorkerMode } from "./reasoning-plan";

export const MODULE_REGISTRY_VERSION = "ompk.module-registry/v1" as const;

export type ModuleFamily =
	| "contract_and_framing"
	| "exploration"
	| "strategy"
	| "execution"
	| "verification"
	| "synthesis";

export interface ModuleDescriptor {
	readonly moduleId: string;
	readonly version: string;
	readonly family: ModuleFamily;
	readonly displayName: string;
	readonly description: string;
	readonly defaultWorkerMode: WorkerMode;
	readonly estimatedCost: EstimatedMagnitude;
	readonly estimatedValue: EstimatedMagnitude;
	/** Module IDs that must complete before this one can run. */
	readonly hardDependencies: readonly string[];
	/** Whether this module produces evidence that the completion gate requires. */
	readonly producesCompletionEvidence: boolean;
}

const MODULES: readonly ModuleDescriptor[] = Object.freeze([
	// ── Contract and framing ──────────────────────────────────────────────────
	Object.freeze({
		moduleId: "objective-normalization",
		version: "1.0",
		family: "contract_and_framing",
		displayName: "Objective Normalization",
		description: "Extract and sharpen the core objective from a raw user request.",
		defaultWorkerMode: "analyze",
		estimatedCost: "low",
		estimatedValue: "medium",
		hardDependencies: [],
		producesCompletionEvidence: false,
	}),
	Object.freeze({
		moduleId: "deliverable-definition",
		version: "1.0",
		family: "contract_and_framing",
		displayName: "Deliverable Definition",
		description: "Enumerate and define concrete deliverables from the accepted contract.",
		defaultWorkerMode: "analyze",
		estimatedCost: "low",
		estimatedValue: "high",
		hardDependencies: ["objective-normalization"],
		producesCompletionEvidence: false,
	}),
	Object.freeze({
		moduleId: "constraint-extraction",
		version: "1.0",
		family: "contract_and_framing",
		displayName: "Constraint Extraction",
		description: "Identify hard and soft constraints from task and context.",
		defaultWorkerMode: "analyze",
		estimatedCost: "low",
		estimatedValue: "medium",
		hardDependencies: [],
		producesCompletionEvidence: false,
	}),
	Object.freeze({
		moduleId: "non-solution-analysis",
		version: "1.0",
		family: "contract_and_framing",
		displayName: "Non-Solution Analysis",
		description: "Enumerate patterns that would be mistaken for completion but are not.",
		defaultWorkerMode: "analyze",
		estimatedCost: "low",
		estimatedValue: "medium",
		hardDependencies: [],
		producesCompletionEvidence: false,
	}),
	Object.freeze({
		moduleId: "failure-mode-enumeration",
		version: "1.0",
		family: "contract_and_framing",
		displayName: "Failure Mode Enumeration",
		description: "Enumerate likely failure modes to inform strategy and test design.",
		defaultWorkerMode: "analyze",
		estimatedCost: "low",
		estimatedValue: "medium",
		hardDependencies: [],
		producesCompletionEvidence: false,
	}),
	Object.freeze({
		moduleId: "ambiguity-assessment",
		version: "1.0",
		family: "contract_and_framing",
		displayName: "Ambiguity Assessment",
		description: "Identify consequential ambiguities and surface questions with highest resolution value.",
		defaultWorkerMode: "analyze",
		estimatedCost: "low",
		estimatedValue: "medium",
		hardDependencies: [],
		producesCompletionEvidence: false,
	}),
	Object.freeze({
		moduleId: "assumption-management",
		version: "1.0",
		family: "contract_and_framing",
		displayName: "Assumption Management",
		description: "Record assumptions with verification status and exposure plan.",
		defaultWorkerMode: "analyze",
		estimatedCost: "low",
		estimatedValue: "medium",
		hardDependencies: [],
		producesCompletionEvidence: false,
	}),

	// ── Exploration ───────────────────────────────────────────────────────────
	Object.freeze({
		moduleId: "source-discovery",
		version: "1.0",
		family: "exploration",
		displayName: "Source Discovery",
		description: "Locate and map relevant source files, packages, and configuration.",
		defaultWorkerMode: "explore",
		estimatedCost: "low",
		estimatedValue: "high",
		hardDependencies: [],
		producesCompletionEvidence: true,
	}),
	Object.freeze({
		moduleId: "repository-mapping",
		version: "1.0",
		family: "exploration",
		displayName: "Repository Mapping",
		description: "Build a structural map of the repository: packages, deps, build, CI.",
		defaultWorkerMode: "explore",
		estimatedCost: "low",
		estimatedValue: "high",
		hardDependencies: [],
		producesCompletionEvidence: false,
	}),
	Object.freeze({
		moduleId: "tool-readiness",
		version: "1.0",
		family: "exploration",
		displayName: "Tool Readiness",
		description: "Verify required tools, runtimes, and external services are available.",
		defaultWorkerMode: "explore",
		estimatedCost: "low",
		estimatedValue: "high",
		hardDependencies: [],
		producesCompletionEvidence: true,
	}),
	Object.freeze({
		moduleId: "prior-art-search",
		version: "1.0",
		family: "exploration",
		displayName: "Prior Art Search",
		description: "Find existing implementations, prototypes, and overlapping code.",
		defaultWorkerMode: "explore",
		estimatedCost: "low",
		estimatedValue: "medium",
		hardDependencies: [],
		producesCompletionEvidence: false,
	}),
	Object.freeze({
		moduleId: "state-inspection",
		version: "1.0",
		family: "exploration",
		displayName: "State Inspection",
		description: "Inspect live system state: processes, databases, file system, services.",
		defaultWorkerMode: "explore",
		estimatedCost: "low",
		estimatedValue: "high",
		hardDependencies: [],
		producesCompletionEvidence: true,
	}),
	Object.freeze({
		moduleId: "reproduction",
		version: "1.0",
		family: "exploration",
		displayName: "Reproduction",
		description: "Reproduce reported failures or behaviors with real command output.",
		defaultWorkerMode: "explore",
		estimatedCost: "medium",
		estimatedValue: "high",
		hardDependencies: ["source-discovery"],
		producesCompletionEvidence: true,
	}),

	// ── Strategy ──────────────────────────────────────────────────────────────
	Object.freeze({
		moduleId: "decomposition",
		version: "1.0",
		family: "strategy",
		displayName: "Decomposition",
		description: "Break the task into independent, parallelizable sub-problems.",
		defaultWorkerMode: "analyze",
		estimatedCost: "low",
		estimatedValue: "medium",
		hardDependencies: ["objective-normalization"],
		producesCompletionEvidence: false,
	}),
	Object.freeze({
		moduleId: "hypothesis-portfolio",
		version: "1.0",
		family: "strategy",
		displayName: "Hypothesis Portfolio",
		description: "Generate multiple credible implementation approaches before committing.",
		defaultWorkerMode: "analyze",
		estimatedCost: "low",
		estimatedValue: "medium",
		hardDependencies: [],
		producesCompletionEvidence: false,
	}),
	Object.freeze({
		moduleId: "risk-first-planning",
		version: "1.0",
		family: "strategy",
		displayName: "Risk-First Planning",
		description: "Rank work by risk and schedule falsification of highest-risk assumptions early.",
		defaultWorkerMode: "analyze",
		estimatedCost: "low",
		estimatedValue: "high",
		hardDependencies: ["failure-mode-enumeration"],
		producesCompletionEvidence: false,
	}),
	Object.freeze({
		moduleId: "critical-path-analysis",
		version: "1.0",
		family: "strategy",
		displayName: "Critical Path Analysis",
		description: "Identify the minimum dependency chain for each deliverable.",
		defaultWorkerMode: "analyze",
		estimatedCost: "low",
		estimatedValue: "medium",
		hardDependencies: ["decomposition"],
		producesCompletionEvidence: false,
	}),

	// ── Execution ─────────────────────────────────────────────────────────────
	Object.freeze({
		moduleId: "direct-execution",
		version: "1.0",
		family: "execution",
		displayName: "Direct Execution",
		description: "Execute a low-risk, obvious, single-step task without spawning workers.",
		defaultWorkerMode: "implement",
		estimatedCost: "low",
		estimatedValue: "high",
		hardDependencies: [],
		producesCompletionEvidence: true,
	}),
	Object.freeze({
		moduleId: "parallel-slice-execution",
		version: "1.0",
		family: "execution",
		displayName: "Parallel Slice Execution",
		description: "Execute independent sub-tasks in parallel with non-overlapping ownership.",
		defaultWorkerMode: "implement",
		estimatedCost: "medium",
		estimatedValue: "high",
		hardDependencies: ["decomposition"],
		producesCompletionEvidence: true,
	}),
	Object.freeze({
		moduleId: "implementation",
		version: "1.0",
		family: "execution",
		displayName: "Implementation",
		description: "Implement the primary deliverable according to the accepted contract.",
		defaultWorkerMode: "implement",
		estimatedCost: "medium",
		estimatedValue: "high",
		hardDependencies: ["source-discovery"],
		producesCompletionEvidence: true,
	}),
	Object.freeze({
		moduleId: "integration",
		version: "1.0",
		family: "execution",
		displayName: "Integration",
		description: "Wire completed components together and verify they work end-to-end.",
		defaultWorkerMode: "implement",
		estimatedCost: "medium",
		estimatedValue: "high",
		hardDependencies: ["implementation"],
		producesCompletionEvidence: true,
	}),

	// ── Verification ──────────────────────────────────────────────────────────
	Object.freeze({
		moduleId: "targeted-test-design",
		version: "1.0",
		family: "verification",
		displayName: "Targeted Test Design",
		description: "Design tests that directly exercise each success criterion contract.",
		defaultWorkerMode: "implement",
		estimatedCost: "medium",
		estimatedValue: "high",
		hardDependencies: ["deliverable-definition"],
		producesCompletionEvidence: true,
	}),
	Object.freeze({
		moduleId: "regression-check",
		version: "1.0",
		family: "verification",
		displayName: "Regression Check",
		description: "Run the existing test suite and record pass/fail evidence.",
		defaultWorkerMode: "audit",
		estimatedCost: "medium",
		estimatedValue: "high",
		hardDependencies: ["implementation"],
		producesCompletionEvidence: true,
	}),
	Object.freeze({
		moduleId: "falsification",
		version: "1.0",
		family: "verification",
		displayName: "Falsification",
		description: "Attempt to disprove the primary hypothesis or implementation claim.",
		defaultWorkerMode: "falsify",
		estimatedCost: "medium",
		estimatedValue: "high",
		hardDependencies: ["implementation"],
		producesCompletionEvidence: true,
	}),
	Object.freeze({
		moduleId: "independent-audit",
		version: "1.0",
		family: "verification",
		displayName: "Independent Audit",
		description: "Fresh-context review of spec compliance, security, and code quality.",
		defaultWorkerMode: "audit",
		estimatedCost: "medium",
		estimatedValue: "high",
		hardDependencies: ["implementation"],
		producesCompletionEvidence: true,
	}),
	Object.freeze({
		moduleId: "completion-audit",
		version: "1.0",
		family: "verification",
		displayName: "Completion Audit",
		description: "Check all criteria, deliverables, and non-solution exclusions are satisfied.",
		defaultWorkerMode: "audit",
		estimatedCost: "low",
		estimatedValue: "high",
		hardDependencies: ["regression-check"],
		producesCompletionEvidence: true,
	}),
	Object.freeze({
		moduleId: "security-review",
		version: "1.0",
		family: "verification",
		displayName: "Security Review",
		description: "Adversarial security review targeting the threat model.",
		defaultWorkerMode: "falsify",
		estimatedCost: "medium",
		estimatedValue: "high",
		hardDependencies: ["implementation"],
		producesCompletionEvidence: true,
	}),

	// ── Synthesis ─────────────────────────────────────────────────────────────
	Object.freeze({
		moduleId: "evidence-synthesis",
		version: "1.0",
		family: "synthesis",
		displayName: "Evidence Synthesis",
		description: "Merge evidence records from multiple modules into a coherent completion picture.",
		defaultWorkerMode: "synthesize",
		estimatedCost: "low",
		estimatedValue: "high",
		hardDependencies: [],
		producesCompletionEvidence: false,
	}),
	Object.freeze({
		moduleId: "output-compilation",
		version: "1.0",
		family: "synthesis",
		displayName: "Output Compilation",
		description: "Assemble all required deliverable artifacts into the final output.",
		defaultWorkerMode: "synthesize",
		estimatedCost: "low",
		estimatedValue: "high",
		hardDependencies: ["integration"],
		producesCompletionEvidence: true,
	}),
	Object.freeze({
		moduleId: "progress-summary",
		version: "1.0",
		family: "synthesis",
		displayName: "Progress Summary",
		description: "Generate an evidence-grounded progress summary for the operator.",
		defaultWorkerMode: "synthesize",
		estimatedCost: "low",
		estimatedValue: "medium",
		hardDependencies: [],
		producesCompletionEvidence: false,
	}),
]);

export class ModuleRegistry {
	readonly #byId = new Map<string, ModuleDescriptor>();
	readonly #version: string;

	constructor() {
		this.#version = MODULE_REGISTRY_VERSION;
		for (const m of MODULES) {
			this.#byId.set(m.moduleId, m);
		}
	}

	get version(): string {
		return this.#version;
	}

	get(moduleId: string): ModuleDescriptor | undefined {
		return this.#byId.get(moduleId);
	}

	has(moduleId: string): boolean {
		return this.#byId.has(moduleId);
	}

	byFamily(family: ModuleFamily): readonly ModuleDescriptor[] {
		return MODULES.filter(m => m.family === family);
	}

	all(): readonly ModuleDescriptor[] {
		return MODULES;
	}

	/** Topological order based on hardDependencies. Returns null if a cycle exists. */
	topologicalOrder(): readonly ModuleDescriptor[] | null {
		const result: ModuleDescriptor[] = [];
		const visited = new Set<string>();
		const visiting = new Set<string>();

		const visit = (id: string): boolean => {
			if (visiting.has(id)) return false;
			if (visited.has(id)) return true;
			visiting.add(id);
			const m = this.#byId.get(id);
			if (!m) return true;
			for (const dep of m.hardDependencies) {
				if (!visit(dep)) return false;
			}
			visiting.delete(id);
			visited.add(id);
			result.push(m);
			return true;
		};

		for (const id of this.#byId.keys()) {
			if (!visit(id)) return null;
		}
		return result;
	}
}

/** Singleton registry instance. */
export const GLOBAL_MODULE_REGISTRY = new ModuleRegistry();
