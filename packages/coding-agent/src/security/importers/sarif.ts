import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	SecurityCoverage,
	SecurityFinding,
	SecurityLocation,
	SecurityProducer,
	SecurityProvenance,
	SecurityScanBundle,
	SecuritySeverityLevel,
} from "../contracts";
import {
	canonicalSecurityJson,
	createSecurityFindingFingerprint,
	createSecurityFindingId,
	createSecurityOccurrenceId,
	createSecurityScanId,
	encodeSecurityProjectKey,
	parseSecurityScanBundle,
} from "../contracts";

interface SarifRegion {
	startLine?: number;
	endLine?: number;
	startColumn?: number;
	endColumn?: number;
}

interface SarifArtifactLocation {
	uri?: string;
	uriBaseId?: string;
}

interface SarifPhysicalLocation {
	artifactLocation?: SarifArtifactLocation;
	region?: SarifRegion;
}

interface SarifResult {
	ruleId?: string;
	level?: string;
	message?: { text?: string; markdown?: string };
	locations?: Array<{ physicalLocation?: SarifPhysicalLocation }>;
	fingerprints?: Record<string, string>;
	partialFingerprints?: Record<string, string>;
	properties?: Record<string, unknown>;
}

interface SarifRule {
	id?: string;
	name?: string;
	shortDescription?: { text?: string };
	properties?: { tags?: unknown } & Record<string, unknown>;
}

interface SarifRun {
	tool?: { driver?: { name?: string; version?: string; rules?: SarifRule[] } };
	results?: SarifResult[];
	originalUriBaseIds?: Record<string, { uri?: string }>;
}

interface SarifLog {
	version?: string;
	runs?: SarifRun[];
}

export interface SarifImportOptions {
	repositoryRoot: string;
	sourcePath?: string;
	createdAt?: string;
	createScanId?: () => string;
}

function severityFromSarif(result: SarifResult): SecuritySeverityLevel {
	const score = Number(result.properties?.["security-severity"]);
	if (Number.isFinite(score)) {
		if (score >= 9) return "critical";
		if (score >= 7) return "high";
		if (score >= 4) return "medium";
		if (score > 0) return "low";
	}
	switch (result.level) {
		case "error":
			return "high";
		case "warning":
			return "medium";
		case "note":
			return "low";
		default:
			return "informational";
	}
}

function pathIsWithin(candidate: string, root: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function resolveSarifArtifactPath(
	artifact: SarifArtifactLocation,
	run: SarifRun,
	repositoryRoot: string,
): Promise<string> {
	const uri = artifact.uri;
	if (!uri) throw new Error("SARIF artifact location is missing its URI");
	const rootUrl = pathToFileURL(`${repositoryRoot}${path.sep}`);
	let baseUrl = rootUrl;
	if (artifact.uriBaseId) {
		const declaredBase = run.originalUriBaseIds?.[artifact.uriBaseId]?.uri;
		if (!declaredBase && artifact.uriBaseId !== "%SRCROOT%") {
			throw new Error(`SARIF artifact uses an unknown URI base: ${artifact.uriBaseId}`);
		}
		baseUrl = declaredBase ? new URL(declaredBase, rootUrl) : rootUrl;
	}
	const resolvedUrl = new URL(uri.replaceAll("\\", "/"), baseUrl);
	if (resolvedUrl.protocol !== "file:") {
		throw new Error(`SARIF artifact URI must resolve to a repository file: ${uri}`);
	}
	const absolute = path.resolve(fileURLToPath(resolvedUrl));
	if (!pathIsWithin(absolute, repositoryRoot)) {
		throw new Error(`SARIF artifact resolves outside the repository: ${uri}`);
	}
	const canonical = await fs.realpath(absolute).catch(error => {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return absolute;
		throw error;
	});
	if (!pathIsWithin(canonical, repositoryRoot)) {
		throw new Error(`SARIF artifact resolves outside the repository through a symbolic link: ${uri}`);
	}
	return path.relative(repositoryRoot, canonical).replaceAll(path.sep, "/");
}

async function normalizeSarifLocations(
	result: SarifResult,
	run: SarifRun,
	repositoryRoot: string,
): Promise<SecurityLocation[]> {
	const locations: SecurityLocation[] = [];
	for (const item of result.locations ?? []) {
		const physical = item.physicalLocation;
		const artifact = physical?.artifactLocation;
		const region = physical?.region;
		const startLine = region?.startLine;
		if (!artifact?.uri || !startLine || startLine < 1) continue;
		const location: SecurityLocation = {
			path: await resolveSarifArtifactPath(artifact, run, repositoryRoot),
			startLine,
			role: "primary",
		};
		if (region.endLine !== undefined) location.endLine = region.endLine;
		if (region.startColumn !== undefined) location.startColumn = region.startColumn;
		if (region.endColumn !== undefined) location.endColumn = region.endColumn;
		locations.push(location);
	}
	return locations.length > 0 ? locations : [{ path: "unknown", startLine: 1, role: "unknown" }];
}

function stringRecord(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const result: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string") result[key] = item;
	}
	return result;
}

function tagsForRule(rule: SarifRule | undefined): string[] {
	const tags = rule?.properties?.tags;
	return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
}
function selectFirstVendorFingerprint(vendorFingerprints: Record<string, string>): string | undefined {
	for (const [, value] of Object.entries(vendorFingerprints).sort(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0,
	)) {
		if (value) return value;
	}
	return undefined;
}

function semanticResultAnchor(
	ruleId: string,
	category: string,
	message: string,
	locations: readonly SecurityLocation[],
): string {
	return `sarif-result/v1:sha256:${Bun.SHA256.hash(
		canonicalSecurityJson({
			ruleId,
			category,
			message,
			locations,
		}),
		"hex",
	)}`;
}
const canonicalValidationStatuses: Record<string, true> = {
	unvalidated: true,
	validated: true,
	rejected: true,
	partial: true,
	error: true,
};

const canonicalDispositionStatuses: Record<string, true> = {
	open: true,
	false_positive: true,
	accepted_risk: true,
	fixed: true,
	wont_fix: true,
};

function importedValidationStatus(value: unknown): SecurityFinding["validation"]["status"] {
	return typeof value === "string" && canonicalValidationStatuses[value] === true
		? (value as SecurityFinding["validation"]["status"])
		: "unvalidated";
}

function importedDispositionStatus(value: unknown): SecurityFinding["disposition"]["status"] {
	return typeof value === "string" && canonicalDispositionStatuses[value] === true
		? (value as SecurityFinding["disposition"]["status"])
		: "open";
}

export async function importSarif(input: unknown, options: SarifImportOptions): Promise<SecurityScanBundle> {
	const sarif = input as SarifLog;
	if (sarif.version !== "2.1.0" || !Array.isArray(sarif.runs)) {
		throw new Error("Expected SARIF 2.1.0 input");
	}
	const canonicalRoot = await fs.realpath(path.resolve(options.repositoryRoot));
	const scanId = options.createScanId?.() ?? createSecurityScanId();
	const createdAt = options.createdAt ?? new Date().toISOString();
	const findings: SecurityFinding[] = [];
	const seenFingerprints = new Set<string>();
	let producerName = "SARIF importer";
	let producerVersion: string | undefined;

	for (const run of sarif.runs) {
		const driver = run.tool?.driver;
		producerName = driver?.name || producerName;
		producerVersion = driver?.version ?? producerVersion;
		const rules = new Map((driver?.rules ?? []).filter(rule => rule.id).map(rule => [rule.id as string, rule]));
		for (const result of run.results ?? []) {
			const ruleId = result.ruleId || "sarif.unknown";
			const rule = rules.get(ruleId);
			const locations = await normalizeSarifLocations(result, run, canonicalRoot);
			const vendorFingerprints = {
				...stringRecord(result.fingerprints),
				...stringRecord(result.partialFingerprints),
			};
			const firstVendorFingerprint = selectFirstVendorFingerprint(vendorFingerprints);
			const category =
				typeof result.properties?.category === "string"
					? result.properties.category
					: ruleId.split(/[./-]/)[0] || "security";
			const message = result.message?.text ?? result.message?.markdown ?? rule?.shortDescription?.text ?? ruleId;
			const anchor = firstVendorFingerprint ?? semanticResultAnchor(ruleId, category, message, locations);
			const fingerprint = createSecurityFindingFingerprint({
				ruleId,
				category,
				anchor,
				locations,
			});
			if (seenFingerprints.has(fingerprint)) continue;
			seenFingerprints.add(fingerprint);
			const tags = tagsForRule(rule);
			const provenance: SecurityProvenance = {
				producer: { kind: "sarif-import", name: producerName },
				createdAt,
				importedAt: new Date().toISOString(),
				vendorFingerprints,
			};
			if (producerVersion !== undefined) provenance.producer.version = producerVersion;
			if (options.sourcePath) provenance.metadata = { sourcePath: options.sourcePath };
			const finding: SecurityFinding = {
				id: createSecurityFindingId(fingerprint),
				scanId,
				fingerprint,
				ruleId,
				title: rule?.shortDescription?.text ?? rule?.name ?? ruleId,
				summary: message,
				severity: { level: severityFromSarif(result) },
				confidence: { level: "medium", rationale: "Imported from a SARIF producer" },
				taxonomy: {
					category,
					cwe: tags.filter(tag => /^CWE-\d+$/i.test(tag)).map(tag => tag.toUpperCase()),
					tags,
				},
				occurrences: [{ id: createSecurityOccurrenceId(fingerprint, locations), locations, evidenceIds: [] }],
				evidence: [],
				validation: { status: importedValidationStatus(result.properties?.validation), evidenceIds: [] },
				disposition: { status: importedDispositionStatus(result.properties?.disposition) },
				provenance,
			};
			finding.anchor = anchor;
			const score = Number(result.properties?.["security-severity"]);
			if (Number.isFinite(score)) finding.severity.score = score;
			findings.push(finding);
		}
	}

	const coverage: SecurityCoverage = {
		mode: "imported",
		completeness: "unknown",
		inventoryStrategy: "imported",
		includePaths: [],
		excludePaths: [],
		surfaces: [],
		explicitExclusions: [],
		deferred: [{ id: "sarif-coverage", reason: "SARIF does not define repository coverage" }],
	};
	const producer: SecurityProducer = { kind: "sarif-import", name: producerName };
	if (producerVersion !== undefined) producer.version = producerVersion;
	const scanProvenance: SecurityProvenance = {
		producer,
		createdAt,
		importedAt: new Date().toISOString(),
	};
	if (options.sourcePath) scanProvenance.metadata = { sourcePath: options.sourcePath };
	return parseSecurityScanBundle({
		scan: {
			documentType: "omp-security.scan",
			schemaVersion: "1.0",
			id: scanId,
			projectKey: encodeSecurityProjectKey(canonicalRoot),
			status: "completed",
			createdAt,
			completedAt: createdAt,
			target: {
				kind: "imported",
				repositoryRoot: canonicalRoot,
				displayName: path.basename(canonicalRoot),
				includePaths: [],
				excludePaths: [],
				treeDigest: Bun.SHA256.hash(JSON.stringify(input), "hex"),
			},
			producer,
			provenance: scanProvenance,
			findingIds: findings.map(finding => finding.id),
			coverage,
			reportRef: "report.md",
			sarifRef: "results.sarif",
		},
		findings,
		report: `# Imported SARIF security results\n\nProducer: ${producerName}\n\nFindings: ${findings.length}\n`,
		sarif: input as Record<string, unknown>,
	});
}

export async function importSarifFile(
	filePath: string,
	options: Omit<SarifImportOptions, "sourcePath">,
): Promise<SecurityScanBundle> {
	return importSarif(JSON.parse(await Bun.file(filePath).text()) as unknown, {
		...options,
		sourcePath: path.resolve(filePath),
	});
}
