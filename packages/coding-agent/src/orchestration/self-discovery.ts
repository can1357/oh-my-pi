/**
 * Self-discovery trigger classifier.
 *
 * Decides whether a task contract warrants full self-discovery (ReasoningPlanV1
 * compilation + module selection + plan audit) or can be executed directly.
 *
 * Direct execution is appropriate only for low-risk, obvious, single-step work.
 * Self-discovery is triggered when any of the following are material:
 *   - multiple dependent steps
 *   - high consequence or security sensitivity
 *   - consequential ambiguity
 *   - architecture or migration decisions
 *   - research-heavy or tool-heavy work
 *   - multiple credible strategy families
 *   - independent verification value
 *   - long execution horizon
 *   - substantial cost or cleanup risk
 */

import type { TaskContractV1 } from "./task-contract";

export type SelfDiscoveryDecision = "direct" | "self_discovery";

export interface SelfDiscoveryClassification {
	readonly decision: SelfDiscoveryDecision;
	readonly reasons: readonly string[];
	readonly confidence: number;
}

const HIGH_RISK_KEYWORDS: readonly string[] = Object.freeze([
	"security",
	"credential",
	"secret",
	"auth",
	"permission",
	"privilege",
	"sandbox",
	"isolat",
	"container",
	"docker",
	"kubernetes",
	"remote",
	"deploy",
	"production",
	"migrate",
	"migration",
	"architecture",
	"redesign",
	"refactor",
	"rewrite",
	"cleanup",
	"delete",
	"destroy",
	"revoke",
	"credential",
	"ssh",
	"network",
	"firewall",
	"egress",
	"ingress",
]);

const MULTI_STEP_KEYWORDS: readonly string[] = Object.freeze([
	"implement",
	"build",
	"integrate",
	"wire",
	"add.*and",
	"then",
	"after",
	"phase",
	"step",
	"first.*then",
	"end.to.end",
	"full",
	"complete",
	"system",
	"pipeline",
	"workflow",
]);

const RESEARCH_KEYWORDS: readonly string[] = Object.freeze([
	"investigate",
	"research",
	"explore",
	"discover",
	"analyze",
	"analyse",
	"compare",
	"audit",
	"review",
	"evaluate",
	"assess",
	"diagnose",
	"debug",
	"trace",
	"profile",
	"inspect",
]);

function matchesAny(text: string, patterns: readonly string[]): boolean {
	const lower = text.toLowerCase();
	return patterns.some(p => {
		try {
			return new RegExp(p).test(lower);
		} catch {
			return lower.includes(p);
		}
	});
}

/**
 * Classify whether a task contract warrants self-discovery or can be executed directly.
 */
export function classifyForSelfDiscovery(contract: TaskContractV1): SelfDiscoveryClassification {
	const reasons: string[] = [];
	let score = 0;

	const fullText = [
		contract.objective,
		...contract.deliverables,
		...contract.constraints,
		...contract.completionCriteria.map(c => c.description),
	].join(" ");

	if (contract.orchestrationPolicy.searchBudget) {
		reasons.push("explicit search budget in orchestration policy");
		score += 3;
	}

	const maxFamilies = contract.orchestrationPolicy.maxInitialFamilies ?? 0;
	if (maxFamilies > 1) {
		reasons.push(`maxInitialFamilies=${maxFamilies} implies multiple parallel work families`);
		score += 2;
	}

	if (contract.completionCriteria.length > 2) {
		reasons.push(`${contract.completionCriteria.length} completion criteria indicate multi-step work`);
		score += 2;
	}

	if (contract.deliverables.length > 2) {
		reasons.push(`${contract.deliverables.length} deliverables indicate substantial scope`);
		score += 1;
	}

	if (contract.knownFailureModes.length > 2) {
		reasons.push(`${contract.knownFailureModes.length} known failure modes indicate complexity`);
		score += 1;
	}

	if (contract.evidenceRequirements.length > 1) {
		reasons.push(`${contract.evidenceRequirements.length} evidence requirements indicate verification depth`);
		score += 1;
	}

	if (matchesAny(fullText, HIGH_RISK_KEYWORDS)) {
		reasons.push("high-risk keywords detected (security, remote, deploy, credential, etc.)");
		score += 3;
	}

	if (matchesAny(fullText, MULTI_STEP_KEYWORDS)) {
		reasons.push("multi-step or system-level keywords detected");
		score += 2;
	}

	if (matchesAny(fullText, RESEARCH_KEYWORDS)) {
		reasons.push("research/exploration keywords detected");
		score += 1;
	}

	if (contract.assumptions.some(a => !a.verified)) {
		reasons.push("unverified assumptions present");
		score += 1;
	}

	if (!contract.verificationPolicy.allowNarrativeOnly) {
		score += 1;
	}

	if (contract.verificationPolicy.requireTargetedChecks && contract.evidenceRequirements.length > 0) {
		reasons.push("targeted evidence checks required");
		score += 1;
	}

	const DIRECT_THRESHOLD = 1;
	const decision: SelfDiscoveryDecision = score <= DIRECT_THRESHOLD ? "direct" : "self_discovery";

	if (decision === "direct" && reasons.length === 0) {
		reasons.push("low-risk single-step task, no triggering signals detected");
	}

	const maxScore = 16;
	const confidence = Math.min(1, score / maxScore);

	return Object.freeze({
		decision,
		reasons: Object.freeze([...reasons]),
		confidence: Math.round(confidence * 100) / 100,
	});
}
