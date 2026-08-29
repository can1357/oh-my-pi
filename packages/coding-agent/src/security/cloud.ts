import { decodeJwt } from "@oh-my-pi/pi-ai/registry/oauth/openai-codex";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { AuthStorage } from "../session/auth-storage";
import { resolveExactSecurityOAuthAccess } from "./auth";
import {
	createSecurityEvidenceId,
	createSecurityFindingFingerprint,
	createSecurityFindingId,
	createSecurityOccurrenceId,
	createSecurityScanId,
	type SecurityAccountRef,
	type SecurityConfidenceLevel,
	type SecurityDispositionStatus,
	type SecurityEvidence,
	type SecurityFinding,
	type SecurityLocation,
	type SecurityProducer,
	type SecurityProvenance,
	type SecurityScanBundle,
	type SecuritySeverityLevel,
} from "./contracts";
import { exportSecurityBundleToSarif } from "./sarif";
import type { SecurityStore } from "./store";

/**
 * ChatGPT's Codex Security cloud control plane. This authenticated web-app
 * contract is not a public OpenAI API: keep it isolated here, fail closed on
 * shape changes, and never use it as a fallback for OMP-native inference.
 */
const DEFAULT_CLOUD_BASE_URL = "https://chatgpt.com/backend-api/aardvark";
const ALL_FINDING_STATUSES = ["new", "triaged", "in_progress", "fixed", "wontfix", "duplicate", "false_positive"];
const CLOUD_PRODUCER: SecurityProducer = {
	kind: "codex-security-cloud",
	name: "Codex Security cloud",
	vendor: "OpenAI",
};

type JsonObject = Record<string, unknown>;

export type CodexSecurityCloudFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CodexSecurityCloudClientOptions {
	authStorage: AuthStorage;
	account: SecurityAccountRef;
	baseUrl?: string;
	fetch?: CodexSecurityCloudFetch;
}

export interface CodexSecurityCloudConfiguration {
	id: string;
	sourceId?: string;
	repositoryId: string;
	repositoryUrl: string;
	environmentId: string;
	state?: string;
	currentStep?: string;
	scanType?: string;
	remainingScans?: number;
	totalScans?: number;
	createdAt?: string;
	updatedAt?: string;
}

export interface CodexSecurityCloudConfigurationPage {
	items: CodexSecurityCloudConfiguration[];
	nextCursor?: string;
	totalInAccount?: number;
}

export interface StartCodexSecurityCloudScanInput {
	repositoryId: string;
	repositoryUrl: string;
	environmentId: string;
	lookbackDays?: number | "all";
	maintainerAttackConcerns?: string;
	maintainerFocusAreas?: string;
	maintainerAdditionalContext?: string;
	signal?: AbortSignal;
}

export interface CodexSecurityCloudStats {
	configurationId: string;
	sourceConfigurationId?: string;
	currentStep?: string;
	pendingCommits: number;
	finishedCommits: number;
	failedCommits: number;
	findingCounts: Record<SecuritySeverityLevel, number>;
	lastScannedCommit?: string;
	lastScannedAt?: string;
	updatedAt?: string;
}

export interface PullCodexSecurityCloudResultsInput {
	client: CodexSecurityCloudClient;
	configurationId: string;
	store: SecurityStore;
	signal?: AbortSignal;
}

function object(value: unknown): JsonObject {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Codex Security cloud returned an invalid object");
	return value as JsonObject;
}

function optionalObject(value: unknown): JsonObject {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0)
		throw new Error(`Codex Security cloud response is missing ${field}`);
	return value;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function normalizeConfiguration(value: unknown): CodexSecurityCloudConfiguration {
	const raw = object(value);
	const scanInput = object(raw.scan_input);
	const id = requiredString(raw.hid ?? raw.id, "configuration id");
	const configuration: CodexSecurityCloudConfiguration = {
		id,
		repositoryId: requiredString(scanInput.repo_id, "repository id"),
		repositoryUrl: requiredString(scanInput.repo_url, "repository URL"),
		environmentId: requiredString(scanInput.environment_id, "environment id"),
	};
	const sourceId = optionalString(raw.id);
	if (sourceId && sourceId !== id) configuration.sourceId = sourceId;
	const state = optionalString(scanInput.state);
	if (state) configuration.state = state;
	const currentStep = optionalString(raw.current_step);
	if (currentStep) configuration.currentStep = currentStep;
	const scanType = optionalString(scanInput.scan_type);
	if (scanType) configuration.scanType = scanType;
	const remainingScans = typeof raw.scans_remaining === "number" ? raw.scans_remaining : raw.remaining_scans;
	if (typeof remainingScans === "number" && Number.isFinite(remainingScans))
		configuration.remainingScans = remainingScans;
	if (typeof raw.total_scans === "number" && Number.isFinite(raw.total_scans))
		configuration.totalScans = raw.total_scans;
	const createdAt = optionalString(raw.created_at);
	if (createdAt) configuration.createdAt = createdAt;
	const updatedAt = optionalString(raw.updated_at);
	if (updatedAt) configuration.updatedAt = updatedAt;
	return configuration;
}

function jwtSubject(accessToken: string): string {
	const claims = decodeJwt(accessToken);
	if (!claims) throw new Error("The selected ChatGPT credential is not a valid JWT");
	return requiredString(claims.sub ?? claims.user_id, "authenticated user id");
}

export class CodexSecurityCloudHttpError extends Error {
	constructor(
		readonly status: number,
		readonly endpoint: string,
	) {
		super(`Codex Security cloud request failed (${status}) at ${endpoint}`);
		this.name = "CodexSecurityCloudHttpError";
	}
}

interface CloudRequestOptions {
	method?: "GET" | "POST";
	query?: Record<string, string | number | undefined>;
	body?: JsonObject | ((accessToken: string) => JsonObject);
	signal?: AbortSignal;
}

export class CodexSecurityCloudClient {
	readonly #authStorage: AuthStorage;
	readonly #account: SecurityAccountRef;
	readonly #baseUrl: string;
	readonly #fetch: CodexSecurityCloudFetch;

	constructor(options: CodexSecurityCloudClientOptions) {
		if (options.account.provider !== "openai-codex") {
			throw new Error("Codex Security cloud requires an openai-codex ChatGPT OAuth credential");
		}
		this.#authStorage = options.authStorage;
		this.#account = options.account;
		this.#baseUrl = (options.baseUrl ?? DEFAULT_CLOUD_BASE_URL).replace(/\/$/, "");
		this.#fetch = options.fetch ?? fetch;
	}

	async #request(pathname: string, options: CloudRequestOptions = {}): Promise<JsonObject> {
		const url = new URL(`${this.#baseUrl}/${pathname.replace(/^\//, "")}`);
		for (const [key, value] of Object.entries(options.query ?? {})) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const access = await resolveExactSecurityOAuthAccess(this.#authStorage, this.#account, {
				forceRefresh: attempt > 0,
				signal: options.signal,
			});
			const body = typeof options.body === "function" ? options.body(access.accessToken) : options.body;
			const headers: Record<string, string> = {
				Accept: "application/json",
				Authorization: `Bearer ${access.accessToken}`,
			};
			const accountId = access.accountId ?? this.#account.accountId;
			if (accountId) headers["ChatGPT-Account-Id"] = accountId;
			if (body) headers["Content-Type"] = "application/json";
			const response = await this.#fetch(url, {
				method: options.method ?? "GET",
				headers,
				body: body ? JSON.stringify(body) : undefined,
				signal: options.signal,
			});
			if (response.status === 401 && attempt === 0) continue;
			if (!response.ok) throw new CodexSecurityCloudHttpError(response.status, url.pathname);
			return object(await response.json());
		}
		throw new Error("Codex Security cloud authentication refresh failed");
	}

	async listConfigurations(
		options: { limit?: number; cursor?: string; signal?: AbortSignal } = {},
	): Promise<CodexSecurityCloudConfigurationPage> {
		const raw = await this.#request("scan_configurations", {
			query: { limit: options.limit ?? 100, cursor: options.cursor },
			signal: options.signal,
		});
		const items = Array.isArray(raw.items) ? raw.items.map(normalizeConfiguration) : [];
		const result: CodexSecurityCloudConfigurationPage = { items };
		const nextCursor = optionalString(raw.next_cursor);
		if (nextCursor) result.nextCursor = nextCursor;
		if (typeof raw.total_in_account === "number") result.totalInAccount = raw.total_in_account;
		return result;
	}
	async listAllConfigurations(signal?: AbortSignal): Promise<CodexSecurityCloudConfiguration[]> {
		const configurations: CodexSecurityCloudConfiguration[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.listConfigurations({ limit: 500, cursor, signal });
			configurations.push(...page.items);
			cursor = page.nextCursor;
		} while (cursor);
		return configurations;
	}

	async getConfiguration(configurationId: string, signal?: AbortSignal): Promise<CodexSecurityCloudConfiguration> {
		let cursor: string | undefined;
		do {
			const page = await this.listConfigurations({ limit: 500, cursor, signal });
			const found = page.items.find(item => item.id === configurationId || item.sourceId === configurationId);
			if (found) return found;
			cursor = page.nextCursor;
		} while (cursor);
		throw new Error(`Unknown Codex Security cloud configuration: ${configurationId}`);
	}

	async startScan(input: StartCodexSecurityCloudScanInput): Promise<CodexSecurityCloudConfiguration> {
		if (
			input.lookbackDays !== undefined &&
			input.lookbackDays !== "all" &&
			(!Number.isInteger(input.lookbackDays) || input.lookbackDays < 1)
		) {
			throw new Error("lookbackDays must be a positive integer or 'all'");
		}
		const raw = await this.#request("scan_configurations", {
			method: "POST",
			signal: input.signal,
			body: accessToken => {
				const scanInput: JsonObject = {
					environment_id: input.environmentId,
					lookback_days: input.lookbackDays === "all" ? null : (input.lookbackDays ?? 30),
					notification_rules: [],
					owner_id: jwtSubject(accessToken),
					repo_id: input.repositoryId,
					repo_url: input.repositoryUrl,
					share_targets: [],
					state: "enabled",
				};
				if (input.maintainerAttackConcerns) scanInput.maintainer_attack_concerns = input.maintainerAttackConcerns;
				if (input.maintainerFocusAreas) scanInput.maintainer_focus_areas = input.maintainerFocusAreas;
				if (input.maintainerAdditionalContext)
					scanInput.maintainer_additional_context = input.maintainerAdditionalContext;
				return { scan_input: scanInput };
			},
		});
		return normalizeConfiguration(raw);
	}

	async getStats(configurationId: string, signal?: AbortSignal): Promise<CodexSecurityCloudStats> {
		const raw = await this.#request(`scan_configurations/${encodeURIComponent(configurationId)}/stats`, { signal });
		const result: CodexSecurityCloudStats = {
			configurationId,
			pendingCommits: finiteNumber(raw.pending_commits),
			finishedCommits: finiteNumber(raw.finished_commits),
			failedCommits: finiteNumber(raw.failed_commits),
			findingCounts: {
				critical: finiteNumber(raw.critical_findings),
				high: finiteNumber(raw.high_findings),
				medium: finiteNumber(raw.medium_findings),
				low: finiteNumber(raw.low_findings),
				informational: finiteNumber(raw.informational_findings),
			},
		};
		const sourceConfigurationId = optionalString(raw.config_id);
		if (sourceConfigurationId && sourceConfigurationId !== configurationId) {
			result.sourceConfigurationId = sourceConfigurationId;
		}
		const currentStep = optionalString(raw.current_step);
		if (currentStep) result.currentStep = currentStep;
		const lastScannedCommit = optionalString(raw.last_scanned_commit_hash);
		if (lastScannedCommit) result.lastScannedCommit = lastScannedCommit;
		const lastScannedAt = optionalString(raw.last_scanned_commit_dt);
		if (lastScannedAt) result.lastScannedAt = lastScannedAt;
		const updatedAt = optionalString(raw.updated_at);
		if (updatedAt) result.updatedAt = updatedAt;
		return result;
	}

	async listFindingDetails(
		repositoryUrl: string,
		configuration: CodexSecurityCloudConfiguration,
		signal?: AbortSignal,
	): Promise<JsonObject[]> {
		const summaries: JsonObject[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.#request("scan-findings", {
				query: {
					repo: repositoryUrl,
					limit: 500,
					cursor,
					status: ALL_FINDING_STATUSES.join(","),
				},
				signal,
			});
			if (Array.isArray(page.items)) summaries.push(...page.items.map(object));
			cursor = optionalString(page.next_cursor);
		} while (cursor);
		const configurationIds = new Set([configuration.id, configuration.sourceId].filter((id): id is string => !!id));
		const attributed = (item: JsonObject): boolean => {
			const configuredScanId = optionalString(item.configured_scan_id);
			return configuredScanId === undefined || configurationIds.has(configuredScanId);
		};
		const selected = summaries.filter(attributed);
		const details: JsonObject[] = [];
		for (let index = 0; index < selected.length; index += 8) {
			const batch = selected.slice(index, index + 8);
			details.push(
				...(await Promise.all(
					batch.map(item => {
						const id = requiredString(item.hid ?? item.id, "finding id");
						return this.#request(`scan-findings/${encodeURIComponent(id)}`, { signal });
					}),
				)),
			);
		}
		// The list request is scoped only by repository URL; a summary may omit its
		// configuration id, so re-verify attribution on each detail response before import.
		return details.filter(attributed);
	}
}

function normalizePath(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
	if (
		!normalized ||
		normalized.startsWith("/") ||
		/^[a-zA-Z]:\//.test(normalized) ||
		normalized.split("/").includes("..")
	)
		return undefined;
	return normalized;
}

function severity(value: unknown): SecuritySeverityLevel {
	return value === "critical" || value === "high" || value === "medium" || value === "low" || value === "informational"
		? value
		: "informational";
}

function confidence(commit: JsonObject): SecurityConfidenceLevel {
	const value = commit.validation_confidence;
	if (typeof value === "number") return value >= 0.67 ? "high" : value >= 0.34 ? "medium" : "low";
	return commit.validated === true ? "high" : "medium";
}

function disposition(value: unknown): SecurityDispositionStatus {
	switch (value) {
		case "fixed":
			return "fixed";
		case "false_positive":
			return "false_positive";
		case "wontfix":
			return "wont_fix";
		case "duplicate":
			return "accepted_risk";
		default:
			return "open";
	}
}

function text(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	return undefined;
}

function locationsAndEvidence(
	commit: JsonObject,
	fingerprintSeed: string,
): { locations: SecurityLocation[]; evidence: SecurityEvidence[] } {
	const relevantLines = Array.isArray(commit.relevant_lines) ? commit.relevant_lines : [];
	const locations: SecurityLocation[] = [];
	const evidenceInputs: Array<{
		label: string;
		explanation: string;
		excerpt?: string;
		location?: SecurityLocation;
		kind: SecurityEvidence["kind"];
	}> = [];
	for (const [index, value] of relevantLines.entries()) {
		const line = optionalObject(value);
		const sourcePath = normalizePath(line.path);
		const startLine = positiveInteger(line.start_line_number);
		if (!sourcePath || !startLine) continue;
		const location: SecurityLocation = { path: sourcePath, startLine };
		const endLine = positiveInteger(line.end_line_number);
		if (endLine && endLine >= startLine) location.endLine = endLine;
		locations.push(location);
		const entry: (typeof evidenceInputs)[number] = {
			kind: "code",
			label: `Cloud source evidence ${index + 1}`,
			explanation: text(line.comment) ?? "Source location reported by Codex Security cloud.",
			location,
		};
		const excerpt = text(line.content);
		if (excerpt) entry.excerpt = excerpt;
		evidenceInputs.push(entry);
	}
	if (locations.length === 0 && Array.isArray(commit.files_involved)) {
		for (const value of commit.files_involved) {
			const sourcePath = normalizePath(value);
			if (sourcePath) locations.push({ path: sourcePath, startLine: 1, role: "cloud-file" });
		}
	}
	if (locations.length === 0)
		throw new Error("Codex Security cloud finding has no usable repository-relative location");
	const validationReport = text(commit.validation_report) ?? text(commit.fix_check_report);
	if (validationReport) {
		evidenceInputs.push({
			kind: "validation",
			label: "Cloud validation",
			explanation: validationReport,
		});
	}
	const evidence = evidenceInputs.map((item, index) => ({
		id: createSecurityEvidenceId(fingerprintSeed, item.label, index),
		...item,
	}));
	return { locations, evidence };
}

function normalizeFinding(
	raw: JsonObject,
	scanId: string,
	configuration: CodexSecurityCloudConfiguration,
	importedAt: string,
): SecurityFinding {
	const commit = optionalObject(raw.commit_analysis);
	const title = requiredString(commit.title ?? raw.title, "finding title");
	const ruleId =
		optionalString(commit.rule_id) ??
		`codex-security:${Bun.SHA256.hash(title.trim().toLowerCase(), "hex").slice(0, 16)}`;
	const category = optionalString(commit.category) ?? "codex-security";
	const cloudId = requiredString(raw.hid ?? raw.id, "finding id");
	const preliminary = locationsAndEvidence(commit, cloudId);
	const fingerprint = createSecurityFindingFingerprint({ ruleId, category, locations: preliminary.locations });
	const evidence = preliminary.evidence.map((item, index) => ({
		...item,
		id: createSecurityEvidenceId(fingerprint, item.label, index),
	}));
	const validationEvidenceIds = evidence.filter(item => item.kind === "validation").map(item => item.id);
	const createdAt = optionalString(raw.created_at) ?? importedAt;
	const producer = { ...CLOUD_PRODUCER };
	const sourceIds: Record<string, string> = { cloudConfigurationId: configuration.id, cloudFindingId: cloudId };
	for (const [key, value] of [
		["cloudSourceFindingId", raw.id],
		["cloudScanId", raw.scan_id],
		["cloudJobId", raw.job_id],
	] as const) {
		if (typeof value === "string" && value.length > 0) sourceIds[key] = value;
	}
	const upstream: NonNullable<SecurityProvenance["upstream"]> = { repository: configuration.repositoryUrl };
	const revision = optionalString(commit.commit_hash);
	if (revision) upstream.revision = revision;
	const provenance: SecurityProvenance = {
		producer,
		createdAt,
		importedAt,
		sourceIds,
		upstream,
		metadata: {
			cloudStatus: raw.status ?? null,
			bugStatus: commit.bug_status ?? null,
			securityRelated: commit.security_related ?? null,
			validationMethod: commit.validation_method ?? null,
		},
	};
	const findingSeverity: SecurityFinding["severity"] = { level: severity(raw.criticality ?? commit.criticality) };
	const severityRationale = text(raw.criticality_reason);
	if (severityRationale) findingSeverity.rationale = severityRationale;
	const validation: SecurityFinding["validation"] = {
		status: commit.validated === true ? "validated" : "unvalidated",
		evidenceIds: validationEvidenceIds,
	};
	const validatedAt = optionalString(commit.validation_finished_at);
	if (validatedAt) validation.validatedAt = validatedAt;
	const validationSummary = text(commit.validation_report);
	if (validationSummary) validation.summary = validationSummary;
	const findingDisposition: SecurityFinding["disposition"] = { status: disposition(raw.status) };
	const dispositionRationale = text(raw.resolution_reason);
	if (dispositionRationale) findingDisposition.rationale = dispositionRationale;
	const dispositionUpdatedAt = optionalString(raw.updated_at);
	if (dispositionUpdatedAt) findingDisposition.updatedAt = dispositionUpdatedAt;
	const finding: SecurityFinding = {
		id: createSecurityFindingId(fingerprint),
		scanId,
		fingerprint,
		ruleId,
		title,
		summary: text(commit.description) ?? text(raw.description) ?? title,
		severity: findingSeverity,
		confidence: { level: confidence(commit) },
		taxonomy: { category, cwe: [] },
		occurrences: [
			{
				id: createSecurityOccurrenceId(fingerprint, preliminary.locations),
				locations: preliminary.locations,
				evidenceIds: evidence.filter(item => item.kind === "code").map(item => item.id),
			},
		],
		evidence,
		validation,
		disposition: findingDisposition,
		provenance,
		extensions: {
			cloudFindingVersion: raw.version ?? null,
			cloudValidationConfidence: commit.validation_confidence ?? null,
		},
	};
	const remediation = text(commit.proposed_patch) ?? text(raw.proposed_patch);
	if (remediation) finding.remediation = remediation;
	return finding;
}

function repositoryIdentity(value: string): string {
	const trimmed = value
		.trim()
		.replace(/\/+$/, "")
		.replace(/\.git$/, "");
	const scpStyle = trimmed.match(/^[^@]+@([^:]+):(.+)$/);
	if (scpStyle) return `${scpStyle[1]!.toLowerCase()}/${scpStyle[2]!.replace(/^\/+/, "").toLowerCase()}`;
	try {
		const parsed = new URL(trimmed);
		return `${parsed.hostname.toLowerCase()}/${parsed.pathname.replace(/^\/+/, "").toLowerCase()}`;
	} catch {
		return trimmed.toLowerCase();
	}
}

async function assertCloudRepositoryMatchesStore(
	configuration: CodexSecurityCloudConfiguration,
	store: SecurityStore,
	signal?: AbortSignal,
): Promise<void> {
	const repo = vcs.git(store.repositoryRoot);
	const origin = repo ? await repo.remoteUrl("origin", signal).catch(() => null) : null;
	if (!origin) {
		throw new Error(
			"Codex Security cloud import requires a verifiable repository identity; this project has no 'origin' remote",
		);
	}
	if (repositoryIdentity(origin) !== repositoryIdentity(configuration.repositoryUrl)) {
		throw new Error("Codex Security cloud configuration does not match this project's origin remote");
	}
}

function reportForCloudBundle(
	configuration: CodexSecurityCloudConfiguration,
	stats: CodexSecurityCloudStats,
	findings: SecurityFinding[],
): string {
	const lines = [
		"# Codex Security cloud results",
		"",
		`- Configuration: ${configuration.id}`,
		`- Repository: ${configuration.repositoryUrl}`,
		`- Current step: ${stats.currentStep ?? configuration.currentStep ?? "unknown"}`,
		`- Last scanned commit: ${stats.lastScannedCommit ?? "unknown"}`,
		`- Findings imported: ${findings.length}`,
		"",
		"## Findings",
		"",
	];
	for (const finding of findings) lines.push(`- **${finding.severity.level}** ${finding.title} (${finding.id})`);
	return `${lines.join("\n")}\n`;
}

export async function pullCodexSecurityCloudResults(
	input: PullCodexSecurityCloudResultsInput,
): Promise<SecurityScanBundle> {
	const importedAt = new Date().toISOString();
	const configuration = await input.client.getConfiguration(input.configurationId, input.signal);
	const stats = await input.client.getStats(configuration.id, input.signal);
	await assertCloudRepositoryMatchesStore(configuration, input.store, input.signal);
	const details = await input.client.listFindingDetails(configuration.repositoryUrl, configuration, input.signal);
	const scanId = createSecurityScanId();
	const findings = details.map(item => normalizeFinding(item, scanId, configuration, importedAt));
	const scanSourceIds: Record<string, string> = { cloudConfigurationId: configuration.id };
	if (configuration.sourceId) scanSourceIds.cloudSourceConfigurationId = configuration.sourceId;
	const producer = { ...CLOUD_PRODUCER };
	const revision = stats.lastScannedCommit;
	const bundle: SecurityScanBundle = {
		scan: {
			documentType: "omp-security.scan",
			schemaVersion: "1.0",
			id: scanId,
			projectKey: input.store.projectKey,
			status: "completed",
			createdAt: importedAt,
			completedAt: importedAt,
			target: {
				kind: "imported",
				repositoryRoot: input.store.repositoryRoot,
				displayName: configuration.repositoryUrl,
				includePaths: [],
				excludePaths: [],
				treeDigest: Bun.SHA256.hash(`${configuration.repositoryUrl}\0${revision ?? "unknown"}`, "hex"),
			},
			producer,
			provenance: {
				producer,
				createdAt: configuration.createdAt ?? importedAt,
				importedAt,
				sourceIds: scanSourceIds,
				upstream: { repository: configuration.repositoryUrl },
				metadata: {
					cloudCurrentStep: stats.currentStep ?? configuration.currentStep ?? null,
					cloudUpdatedAt: stats.updatedAt ?? configuration.updatedAt ?? null,
				},
			},
			findingIds: findings.map(item => item.id),
			coverage: {
				mode: "imported",
				completeness: "unknown",
				inventoryStrategy: "imported",
				includePaths: [],
				excludePaths: [],
				surfaces: [],
				explicitExclusions: [],
				deferred: [
					{ id: "cloud-coverage", reason: "Cloud coverage receipts are not exposed by the findings API." },
				],
			},
			reportRef: "report.md",
			sarifRef: "results.sarif",
		},
		findings,
		report: reportForCloudBundle(configuration, stats, findings),
	};
	if (configuration.createdAt) bundle.scan.startedAt = configuration.createdAt;
	if (revision) {
		bundle.scan.target.revision = revision;
		if (bundle.scan.provenance.upstream) bundle.scan.provenance.upstream.revision = revision;
	}
	bundle.sarif = exportSecurityBundleToSarif(bundle);
	await input.store.putBundle(bundle);
	return bundle;
}
