import { type } from "@oh-my-pi/omptype";
import { once } from "@oh-my-pi/pi-utils";

export const getSecurityContractSchemas = once(() => {
	const stringRecordSchema = type({ "[string]": "string" });
	const unknownRecordSchema = type({ "[string]": "unknown" });

	const securityProducerSchema = type({
		kind: "'omp-native' | 'codex-security-bundle' | 'codex-security-cloud' | 'sarif-import'",
		name: "string > 0",
		"version?": "string",
		"vendor?": "string",
		"revision?": "string",
		"pluginVersion?": "string",
	});

	const securityProvenanceSchema = type({
		producer: securityProducerSchema,
		createdAt: "string > 0",
		"importedAt?": "string",
		"sourceIds?": stringRecordSchema,
		"vendorFingerprints?": stringRecordSchema,
		"upstream?": {
			"repository?": "string",
			"revision?": "string",
			"packageVersion?": "string",
			"pluginVersion?": "string",
			"archiveSha256?": "string",
		},
		"metadata?": unknownRecordSchema,
	});

	const securityLocationSchema = type({
		path: "string > 0",
		startLine: "number.integer >= 1",
		"endLine?": "number.integer >= 1",
		"startColumn?": "number.integer >= 1",
		"endColumn?": "number.integer >= 1",
		"role?": "string",
	});

	const securityEvidenceSchema = type({
		id: "string > 0",
		kind: "'code' | 'trace' | 'validation' | 'note'",
		label: "string > 0",
		explanation: "string",
		"location?": securityLocationSchema,
		"excerpt?": "string",
	});

	const securityOccurrenceSchema = type({
		id: "string > 0",
		locations: securityLocationSchema.array().atLeastLength(1),
		evidenceIds: "string[]",
	});

	const securityFindingSchema = type({
		id: "string > 0",
		scanId: "string > 0",
		fingerprint: "string > 0",
		ruleId: "string > 0",
		"anchor?": "string",
		title: "string > 0",
		summary: "string",
		severity: {
			level: "'critical' | 'high' | 'medium' | 'low' | 'informational'",
			"score?": "number",
			"scoringSystem?": "string",
			"vector?": "string",
			"rationale?": "string",
		},
		confidence: {
			level: "'high' | 'medium' | 'low'",
			"rationale?": "string",
		},
		taxonomy: {
			category: "string > 0",
			cwe: "string[]",
			"tags?": "string[]",
		},
		occurrences: securityOccurrenceSchema.array().atLeastLength(1),
		evidence: securityEvidenceSchema.array(),
		"remediation?": "string",
		validation: {
			status: "'unvalidated' | 'validated' | 'rejected' | 'partial' | 'error'",
			"summary?": "string",
			evidenceIds: "string[]",
			"validatedAt?": "string",
		},
		disposition: {
			status: "'open' | 'false_positive' | 'accepted_risk' | 'fixed' | 'wont_fix'",
			"rationale?": "string",
			"updatedAt?": "string",
			"actor?": "string",
		},
		provenance: securityProvenanceSchema,
		"extensions?": unknownRecordSchema,
	});

	const securityCoverageSchema = type({
		mode: "'repository' | 'scoped_path' | 'diff' | 'working_tree' | 'deep_repository' | 'imported'",
		completeness: "'complete' | 'partial' | 'unknown'",
		inventoryStrategy: "'repository' | 'scoped_path' | 'diff' | 'directory' | 'custom' | 'imported'",
		includePaths: "string[]",
		excludePaths: "string[]",
		surfaces: type({
			id: "string > 0",
			label: "string > 0",
			disposition: "'reported' | 'no_issue_found' | 'rejected' | 'not_applicable' | 'needs_follow_up'",
			receiptRefs: "string[]",
			"riskArea?": "string",
			"notes?": "string",
		}).array(),
		explicitExclusions: type({ pattern: "string", reason: "string" }).array(),
		deferred: type({
			id: "string > 0",
			reason: "string > 0",
			"paths?": "string[]",
			"surfaceIds?": "string[]",
		}).array(),
		"openQuestions?": type({ question: "string > 0", "followUpPrompt?": "string" }).array(),
	});

	const securityTargetSchema = type({
		kind: "'repository' | 'scoped_path' | 'ref_diff' | 'working_tree' | 'imported'",
		repositoryRoot: "string > 0",
		displayName: "string > 0",
		"revision?": "string",
		"baseRevision?": "string",
		"headRevision?": "string",
		includePaths: "string[]",
		excludePaths: "string[]",
		treeDigest: "string > 0",
	});

	const securityScanPlanSchema = type({
		documentType: "'omp-security.scan-plan'",
		schemaVersion: "'1.0'",
		id: "string > 0",
		createdAt: "string > 0",
		repositoryRoot: "string > 0",
		target: securityTargetSchema,
		knowledgeBases: type({ path: "string > 0", sha256: "string > 0", size: "number.integer >= 0" }).array(),
		output: {
			root: "string > 0",
			archiveExisting: "boolean",
			existingState: "'absent' | 'empty' | 'archivable'",
		},
		model: { provider: "string > 0", modelId: "string > 0", "thinkingLevel?": "string" },
		account: {
			provider: "string > 0",
			credentialId: "number.integer >= 1",
			"accountId?": "string",
			"email?": "string",
			"organizationId?": "string",
			"organizationName?": "string",
		},
		configFingerprint: "string > 0",
		workflowFingerprint: "string > 0",
		fingerprint: "string > 0",
	});

	const securityScanMetricsSchema = type({
		"runtimeMs?": "number >= 0",
		"tokenUsage?": {
			input: "number >= 0",
			output: "number >= 0",
			reasoning: "number >= 0",
			cacheRead: "number >= 0",
			cacheWrite: "number >= 0",
			total: "number >= 0",
		},
		"cost?": "number >= 0",
		"premiumRequests?": "number >= 0",
	});

	const securityScanSchema = type({
		documentType: "'omp-security.scan'",
		schemaVersion: "'1.0'",
		id: "string > 0",
		projectKey: "string > 0",
		status: "'planned' | 'running' | 'completed' | 'partial' | 'cancelled' | 'failed'",
		createdAt: "string > 0",
		"startedAt?": "string",
		"completedAt?": "string",
		"plan?": securityScanPlanSchema,
		target: securityTargetSchema,
		producer: securityProducerSchema,
		provenance: securityProvenanceSchema,
		findingIds: "string[]",
		coverage: securityCoverageSchema,
		"reportRef?": "string",
		"sarifRef?": "string",
		"error?": "string",
		"metrics?": securityScanMetricsSchema,
	});

	const securityScanBundleSchema = type({
		scan: securityScanSchema,
		findings: securityFindingSchema.array(),
		"report?": "string",
		"sarif?": unknownRecordSchema,
	});

	return {
		securityProducerSchema,
		securityProvenanceSchema,
		securityLocationSchema,
		securityEvidenceSchema,
		securityOccurrenceSchema,
		securityFindingSchema,
		securityCoverageSchema,
		securityTargetSchema,
		securityScanPlanSchema,
		securityScanMetricsSchema,
		securityScanSchema,
		securityScanBundleSchema,
	};
});
