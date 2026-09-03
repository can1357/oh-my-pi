import { type } from "@oh-my-pi/omptype";
import type { ToolDefinition } from "../extensibility/extensions";
import securityPublishDescription from "../prompts/tools/security-publish.md" with { type: "text" };
import type {
	SecurityCoverage,
	SecurityEvidence,
	SecurityFinding,
	SecurityLocation,
	SecurityScan,
	SecurityScanBundle,
	SecurityScanPlan,
} from "./contracts";
import {
	createSecurityEvidenceId,
	createSecurityFindingFingerprint,
	createSecurityFindingId,
	createSecurityOccurrenceId,
} from "./contracts";
import { pathMatchesSecurityScope } from "./preflight";
import { createNativeSecurityProducer, createNativeSecurityProvenance } from "./provenance";
import { exportSecurityBundleToSarif } from "./sarif";
import { type SecurityStore, writeSecurityBundleToDirectory } from "./store";

const publishLocationSchema = type({
	path: type("string > 0").describe("repository-relative source path"),
	start_line: type("number.integer >= 1").describe("1-indexed first source line"),
	"end_line?": type("number.integer >= 1").describe("1-indexed last source line"),
	"start_column?": type("number.integer >= 1").describe("1-indexed first source column"),
	"end_column?": type("number.integer >= 1").describe("1-indexed last source column"),
	"role?": type("string").describe("entrypoint, root_control, sink, or supporting role"),
});

const publishEvidenceSchema = type({
	label: "string > 0",
	explanation: "string",
	"excerpt?": "string",
	"location?": publishLocationSchema,
});

const publishFindingSchema = type({
	rule_id: "string > 0",
	title: "string > 0",
	summary: "string",
	severity: "'critical' | 'high' | 'medium' | 'low' | 'informational'",
	confidence: "'high' | 'medium' | 'low'",
	category: "string > 0",
	"anchor?": "string",
	"cwe?": "string[]",
	locations: publishLocationSchema.array().atLeastLength(1),
	"evidence?": publishEvidenceSchema.array(),
	"remediation?": "string",
	"validation?": "'unvalidated' | 'validated' | 'partial'",
});

const publishSurfaceSchema = type({
	label: "string > 0",
	disposition: "'reported' | 'no_issue_found' | 'rejected' | 'not_applicable' | 'needs_follow_up'",
	"risk_area?": "string",
	"notes?": "string",
	"receipt_refs?": "string[]",
});

const publishDeferredSchema = type({
	reason: "string > 0",
	"paths?": "string[]",
	"surface_ids?": "string[]",
});

export const securityPublishSchema = type({
	findings: publishFindingSchema.array(),
	coverage: {
		completeness: "'complete' | 'partial' | 'unknown'",
		"surfaces?": publishSurfaceSchema.array(),
		"explicit_exclusions?": type({ pattern: "string", reason: "string" }).array(),
		"deferred?": publishDeferredSchema.array(),
		"open_questions?": type({ question: "string > 0", "follow_up_prompt?": "string" }).array(),
	},
	report: "string",
});

export type SecurityPublishParams = typeof securityPublishSchema.infer;

export interface SecurityPublishDetails {
	scanId: string;
	findingCount: number;
	status: "completed";
}

export interface SecurityPublicationOptions {
	plan: SecurityScanPlan;
	scanId: string;
	store: SecurityStore;
	startedAt: string;
	sessionId?: string;
	operationId?: string;
	onPublished?: (bundle: SecurityScanBundle) => void | Promise<void>;
}

function normalizePublishedPath(input: string): string {
	const normalized = input.replaceAll("\\", "/").replace(/^\.\//, "");
	const segments = normalized.split("/");
	if (
		!normalized ||
		normalized.startsWith("/") ||
		/^[a-zA-Z]:\//.test(normalized) ||
		segments.some(segment => segment === "..")
	) {
		throw new Error(`Security finding paths must be repository-relative: ${input}`);
	}
	return normalized;
}

function toLocation(
	input: SecurityPublishParams["findings"][number]["locations"][number],
	plan: SecurityScanPlan,
): SecurityLocation {
	const normalizedPath = normalizePublishedPath(input.path);
	if (!pathMatchesSecurityScope(normalizedPath, plan.target.includePaths, plan.target.excludePaths)) {
		throw new Error(`Security finding path is outside the immutable scan scope: ${input.path}`);
	}
	const location: SecurityLocation = {
		path: normalizedPath,
		startLine: input.start_line,
	};
	if (input.end_line !== undefined) location.endLine = input.end_line;
	if (input.start_column !== undefined) location.startColumn = input.start_column;
	if (input.end_column !== undefined) location.endColumn = input.end_column;
	if (input.role !== undefined) location.role = input.role;
	return location;
}

function coverageMode(plan: SecurityScanPlan): SecurityCoverage["mode"] {
	switch (plan.target.kind) {
		case "ref_diff":
			return "diff";
		case "working_tree":
			return "working_tree";
		case "scoped_path":
			return "scoped_path";
		default:
			return "repository";
	}
}

function inventoryStrategy(plan: SecurityScanPlan): SecurityCoverage["inventoryStrategy"] {
	switch (plan.target.kind) {
		case "ref_diff":
			return "diff";
		case "scoped_path":
			return "scoped_path";
		default:
			return "repository";
	}
}

function buildFinding(
	input: SecurityPublishParams["findings"][number],
	options: SecurityPublicationOptions,
	createdAt: string,
): SecurityFinding {
	const locations = input.locations.map(location => toLocation(location, options.plan));
	const fingerprint = createSecurityFindingFingerprint({
		ruleId: input.rule_id,
		category: input.category,
		anchor: input.anchor,
		locations,
	});
	const evidence: SecurityEvidence[] = (input.evidence ?? []).map((item, index) => {
		const entry: SecurityEvidence = {
			id: createSecurityEvidenceId(fingerprint, item.label, index),
			kind: "code",
			label: item.label,
			explanation: item.explanation,
		};
		if (item.excerpt !== undefined) entry.excerpt = item.excerpt;
		if (item.location !== undefined) entry.location = toLocation(item.location, options.plan);
		return entry;
	});
	const finding: SecurityFinding = {
		id: createSecurityFindingId(fingerprint),
		scanId: options.scanId,
		fingerprint,
		ruleId: input.rule_id,
		title: input.title,
		summary: input.summary,
		severity: { level: input.severity },
		confidence: { level: input.confidence },
		taxonomy: { category: input.category, cwe: input.cwe ?? [] },
		occurrences: [
			{
				id: createSecurityOccurrenceId(fingerprint, locations),
				locations,
				evidenceIds: evidence.map(item => item.id),
			},
		],
		evidence,
		validation: { status: input.validation ?? "unvalidated", evidenceIds: [] },
		disposition: { status: "open" },
		provenance: createNativeSecurityProvenance({
			createdAt,
			account: options.plan.account,
			planFingerprint: options.plan.fingerprint,
			workflowFingerprint: options.plan.workflowFingerprint,
			sessionId: options.sessionId,
		}),
	};
	if (input.anchor !== undefined) finding.anchor = input.anchor;
	if (input.remediation !== undefined) finding.remediation = input.remediation;
	return finding;
}

function buildCoverage(params: SecurityPublishParams, plan: SecurityScanPlan): SecurityCoverage {
	const surfaces: SecurityCoverage["surfaces"] = (params.coverage.surfaces ?? []).map((surface, index) => {
		const entry: SecurityCoverage["surfaces"][number] = {
			id: `surface-${index + 1}`,
			label: surface.label,
			disposition: surface.disposition,
			receiptRefs: surface.receipt_refs ?? [],
		};
		if (surface.risk_area !== undefined) entry.riskArea = surface.risk_area;
		if (surface.notes !== undefined) entry.notes = surface.notes;
		return entry;
	});
	const deferred: SecurityCoverage["deferred"] = (params.coverage.deferred ?? []).map((item, index) => {
		const entry: SecurityCoverage["deferred"][number] = {
			id: `deferred-${index + 1}`,
			reason: item.reason,
		};
		if (item.paths !== undefined) entry.paths = item.paths;
		if (item.surface_ids !== undefined) entry.surfaceIds = item.surface_ids;
		return entry;
	});
	const coverage: SecurityCoverage = {
		mode: coverageMode(plan),
		completeness: params.coverage.completeness,
		inventoryStrategy: inventoryStrategy(plan),
		includePaths: [...plan.target.includePaths],
		excludePaths: [...plan.target.excludePaths],
		surfaces,
		explicitExclusions: params.coverage.explicit_exclusions ?? [],
		deferred,
	};
	if (params.coverage.open_questions !== undefined) {
		coverage.openQuestions = params.coverage.open_questions.map(item => {
			const question: NonNullable<SecurityCoverage["openQuestions"]>[number] = { question: item.question };
			if (item.follow_up_prompt !== undefined) question.followUpPrompt = item.follow_up_prompt;
			return question;
		});
	}
	return coverage;
}

export function createSecurityPublicationTool(
	options: SecurityPublicationOptions,
): ToolDefinition<typeof securityPublishSchema, SecurityPublishDetails> {
	let published = false;
	return {
		name: "security_publish",
		label: "Publish Security Scan",
		description: securityPublishDescription.trim(),
		parameters: securityPublishSchema,
		approval: "write",
		strict: true,
		async execute(_toolCallId, params) {
			if (published) throw new Error(`Security scan ${options.scanId} has already been published`);
			published = true;
			let persisted = false;
			try {
				const completedAt = new Date().toISOString();
				const findingsByFingerprint = new Map<string, SecurityFinding>();
				for (const input of params.findings) {
					const finding = buildFinding(input, options, completedAt);
					if (!findingsByFingerprint.has(finding.fingerprint)) {
						findingsByFingerprint.set(finding.fingerprint, finding);
					}
				}
				const findings = [...findingsByFingerprint.values()];
				const producer = createNativeSecurityProducer();
				const provenance = createNativeSecurityProvenance({
					createdAt: options.startedAt,
					account: options.plan.account,
					planFingerprint: options.plan.fingerprint,
					workflowFingerprint: options.plan.workflowFingerprint,
					sessionId: options.sessionId,
					operationId: options.operationId,
				});
				const scan: SecurityScan = {
					documentType: "omp-security.scan",
					schemaVersion: "1.0",
					id: options.scanId,
					projectKey: options.store.projectKey,
					status: "completed",
					createdAt: options.plan.createdAt,
					startedAt: options.startedAt,
					completedAt,
					plan: options.plan,
					target: options.plan.target,
					producer,
					provenance,
					findingIds: findings.map(finding => finding.id),
					coverage: buildCoverage(params, options.plan),
					reportRef: "report.md",
					sarifRef: "results.sarif",
				};
				const provisional: SecurityScanBundle = { scan, findings, report: params.report };
				const bundle: SecurityScanBundle = { ...provisional, sarif: exportSecurityBundleToSarif(provisional) };
				await writeSecurityBundleToDirectory(options.plan.output.root, bundle);
				await options.store.putBundle(bundle);
				persisted = true;
				await options.onPublished?.(bundle);
				return {
					content: [
						{
							type: "text",
							text: `Published security scan ${options.scanId} with ${findings.length} finding(s).`,
						},
					],
					details: { scanId: options.scanId, findingCount: findings.length, status: "completed" },
				};
			} catch (error) {
				if (!persisted) published = false;
				throw error;
			}
		},
	};
}
