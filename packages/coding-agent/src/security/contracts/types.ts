export type SecuritySeverityLevel = "critical" | "high" | "medium" | "low" | "informational";
export type SecurityConfidenceLevel = "high" | "medium" | "low";
export type SecurityScanStatus = "planned" | "running" | "completed" | "partial" | "cancelled" | "failed";
export type SecurityCoverageCompleteness = "complete" | "partial" | "unknown";
export type SecurityValidationStatus = "unvalidated" | "validated" | "rejected" | "partial" | "error";
export type SecurityDispositionStatus = "open" | "false_positive" | "accepted_risk" | "fixed" | "wont_fix";
export type SecurityTargetKind = "repository" | "scoped_path" | "ref_diff" | "working_tree" | "imported";
export type SecurityProducerKind = "omp-native" | "codex-security-bundle" | "codex-security-cloud" | "sarif-import";

export interface SecurityProducer {
	kind: SecurityProducerKind;
	name: string;
	version?: string;
	vendor?: string;
	revision?: string;
	pluginVersion?: string;
}

export interface SecurityUpstreamProvenance {
	repository?: string;
	revision?: string;
	packageVersion?: string;
	pluginVersion?: string;
	archiveSha256?: string;
}

export interface SecurityProvenance {
	producer: SecurityProducer;
	createdAt: string;
	importedAt?: string;
	sourceIds?: Record<string, string>;
	vendorFingerprints?: Record<string, string>;
	upstream?: SecurityUpstreamProvenance;
	metadata?: Record<string, unknown>;
}

export interface SecurityLocation {
	path: string;
	startLine: number;
	endLine?: number;
	startColumn?: number;
	endColumn?: number;
	role?: string;
}

export interface SecurityEvidence {
	id: string;
	kind: "code" | "trace" | "validation" | "note";
	label: string;
	explanation: string;
	location?: SecurityLocation;
	excerpt?: string;
}

export interface SecurityOccurrence {
	id: string;
	locations: SecurityLocation[];
	evidenceIds: string[];
}

export interface SecuritySeverity {
	level: SecuritySeverityLevel;
	score?: number;
	scoringSystem?: string;
	vector?: string;
	rationale?: string;
}

export interface SecurityConfidence {
	level: SecurityConfidenceLevel;
	rationale?: string;
}

export interface SecurityTaxonomy {
	category: string;
	cwe: string[];
	tags?: string[];
}

export interface SecurityValidation {
	status: SecurityValidationStatus;
	summary?: string;
	evidenceIds: string[];
	validatedAt?: string;
}

export interface SecurityDisposition {
	status: SecurityDispositionStatus;
	rationale?: string;
	updatedAt?: string;
	actor?: string;
}

export interface SecurityFinding {
	id: string;
	scanId: string;
	fingerprint: string;
	ruleId: string;
	anchor?: string;
	title: string;
	summary: string;
	severity: SecuritySeverity;
	confidence: SecurityConfidence;
	taxonomy: SecurityTaxonomy;
	occurrences: SecurityOccurrence[];
	evidence: SecurityEvidence[];
	remediation?: string;
	validation: SecurityValidation;
	disposition: SecurityDisposition;
	provenance: SecurityProvenance;
	extensions?: Record<string, unknown>;
}

export interface SecurityCoverageSurface {
	id: string;
	label: string;
	disposition: "reported" | "no_issue_found" | "rejected" | "not_applicable" | "needs_follow_up";
	receiptRefs: string[];
	riskArea?: string;
	notes?: string;
}

export interface SecurityCoverageDeferred {
	id: string;
	reason: string;
	paths?: string[];
	surfaceIds?: string[];
}

export interface SecurityCoverage {
	mode: "repository" | "scoped_path" | "diff" | "working_tree" | "deep_repository" | "imported";
	completeness: SecurityCoverageCompleteness;
	inventoryStrategy: "repository" | "scoped_path" | "diff" | "directory" | "custom" | "imported";
	includePaths: string[];
	excludePaths: string[];
	surfaces: SecurityCoverageSurface[];
	explicitExclusions: Array<{ pattern: string; reason: string }>;
	deferred: SecurityCoverageDeferred[];
	openQuestions?: Array<{ question: string; followUpPrompt?: string }>;
}

export interface SecurityTarget {
	kind: SecurityTargetKind;
	repositoryRoot: string;
	displayName: string;
	revision?: string;
	baseRevision?: string;
	headRevision?: string;
	includePaths: string[];
	excludePaths: string[];
	treeDigest: string;
}

export interface SecurityModelRef {
	provider: string;
	modelId: string;
	thinkingLevel?: string;
}

export interface SecurityAccountRef {
	provider: string;
	credentialId: number;
	accountId?: string;
	email?: string;
	organizationId?: string;
	organizationName?: string;
}

export interface SecurityKnowledgeBaseRef {
	path: string;
	sha256: string;
	size: number;
}

export interface SecurityOutputPlan {
	root: string;
	archiveExisting: boolean;
	existingState: "absent" | "empty" | "archivable";
}

export interface SecurityScanPlan {
	documentType: "omp-security.scan-plan";
	schemaVersion: "1.0";
	id: string;
	createdAt: string;
	repositoryRoot: string;
	target: SecurityTarget;
	knowledgeBases: SecurityKnowledgeBaseRef[];
	output: SecurityOutputPlan;
	model: SecurityModelRef;
	account: SecurityAccountRef;
	configFingerprint: string;
	workflowFingerprint: string;
	fingerprint: string;
}

export interface SecurityScanMetrics {
	runtimeMs?: number;
	tokenUsage?: {
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost?: number;
	premiumRequests?: number;
}

export interface SecurityScan {
	documentType: "omp-security.scan";
	schemaVersion: "1.0";
	id: string;
	projectKey: string;
	status: SecurityScanStatus;
	createdAt: string;
	startedAt?: string;
	completedAt?: string;
	plan?: SecurityScanPlan;
	target: SecurityTarget;
	producer: SecurityProducer;
	provenance: SecurityProvenance;
	findingIds: string[];
	coverage: SecurityCoverage;
	reportRef?: string;
	sarifRef?: string;
	error?: string;
	metrics?: SecurityScanMetrics;
}

export interface SecurityScanBundle {
	scan: SecurityScan;
	findings: SecurityFinding[];
	report?: string;
	sarif?: Record<string, unknown>;
}

export interface SecurityFindingMatch {
	beforeFindingId?: string;
	afterFindingId?: string;
	fingerprint: string;
	status: "unchanged" | "new" | "resolved";
	matchBasis?: "fingerprint" | "rule_location" | "taxonomy_location";
}

export interface SecurityComparisonReport {
	beforeScanId: string;
	afterScanId: string;
	matches: SecurityFindingMatch[];
	unchanged: number;
	introduced: number;
	resolved: number;
}
