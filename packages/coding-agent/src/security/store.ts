import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getSecurityProjectDir, isEnoent } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { compareSecurityLineage } from "./comparison";
import type {
	SecurityComparisonReport,
	SecurityDisposition,
	SecurityEvidence,
	SecurityFinding,
	SecurityScan,
	SecurityScanBundle,
	SecurityScanPlan,
	SecurityValidation,
} from "./contracts";
import {
	encodeSecurityProjectKey,
	parseSecurityFinding,
	parseSecurityScan,
	parseSecurityScanBundle,
	parseSecurityScanPlan,
} from "./contracts";
import { createPublicSecurityScan, redactPrivateSecurityMetadata } from "./provenance";
import { exportSecurityBundleToSarif } from "./sarif";

const STORE_SCHEMA_VERSION = 1;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/** Serialize project-store read/modify/write transactions within this process. */
const SECURITY_STORE_WRITE_CHAINS = new Map<string, Promise<unknown>>();

async function withSecurityStoreWrite<T>(key: string, operation: () => Promise<T>): Promise<T> {
	const lockTarget = path.join(key, "index.json");
	const run = (SECURITY_STORE_WRITE_CHAINS.get(key) ?? Promise.resolve()).then(() =>
		withFileLock(lockTarget, operation, { retries: 200, retryDelayMs: 50 }),
	);
	const guarded = run.catch(() => undefined);
	SECURITY_STORE_WRITE_CHAINS.set(key, guarded);
	try {
		return await run;
	} finally {
		if (SECURITY_STORE_WRITE_CHAINS.get(key) === guarded) SECURITY_STORE_WRITE_CHAINS.delete(key);
	}
}

interface SecurityStoreIndex {
	schemaVersion: 1;
	projectKey: string;
	repositoryRoot: string;
	scanIds: string[];
	planIds: string[];
	updatedAt: string;
}

export interface SecurityScanSummary {
	id: string;
	status: SecurityScan["status"];
	createdAt: string;
	completedAt?: string;
	producer: SecurityScan["producer"];
	findingCount: number;
	target: SecurityScan["target"];
}

export interface SecurityStoreOptions {
	stateRoot?: string;
	signal?: AbortSignal;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
	await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
	if (process.platform !== "win32") await fs.chmod(directory, PRIVATE_DIRECTORY_MODE);
}

export interface SecurityFileWriteOptions {
	hardenParent?: boolean;
}

export async function writeSecurityFileAtomic(
	filePath: string,
	content: string,
	options: SecurityFileWriteOptions = {},
): Promise<void> {
	if (options.hardenParent ?? true) {
		await ensurePrivateDirectory(path.dirname(filePath));
	} else {
		await fs.mkdir(path.dirname(filePath), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
	}
	const temporaryPath = `${filePath}.${process.pid}.${Bun.randomUUIDv7()}.tmp`;
	try {
		// Bun.write cannot create exclusively; `wx` keeps concurrent atomic writers from sharing a temp file.
		await fs.writeFile(temporaryPath, content, { encoding: "utf-8", mode: PRIVATE_FILE_MODE, flag: "wx" });
		if (process.platform !== "win32") await fs.chmod(temporaryPath, PRIVATE_FILE_MODE);
		try {
			await fs.rename(temporaryPath, filePath);
		} catch (error) {
			const code = error instanceof Error && "code" in error ? String(error.code) : "";
			if (process.platform !== "win32" || (code !== "EEXIST" && code !== "EPERM")) throw error;
			await fs.rm(filePath, { force: true });
			await fs.rename(temporaryPath, filePath);
		}
	} finally {
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}
export async function writeSecurityBundleToDirectory(directory: string, input: SecurityScanBundle): Promise<void> {
	const bundle = parseSecurityScanBundle(input);
	const root = path.resolve(directory);
	await ensurePrivateDirectory(root);
	await writeSecurityFileAtomic(path.join(root, "findings.json"), `${JSON.stringify(bundle.findings, null, 2)}\n`);
	if (bundle.report !== undefined) {
		await writeSecurityFileAtomic(path.join(root, "report.md"), bundle.report);
	} else {
		await fs.rm(path.join(root, "report.md"), { force: true });
	}
	if (bundle.sarif !== undefined) {
		await writeSecurityFileAtomic(path.join(root, "results.sarif"), `${JSON.stringify(bundle.sarif, null, 2)}\n`);
	} else {
		await fs.rm(path.join(root, "results.sarif"), { force: true });
	}
	await writeSecurityFileAtomic(
		path.join(root, "provenance.json"),
		`${JSON.stringify(redactPrivateSecurityMetadata(bundle.scan.provenance), null, 2)}\n`,
	);
	// The scan manifest is the commit marker for directory consumers.
	await writeSecurityFileAtomic(
		path.join(root, "scan.json"),
		`${JSON.stringify(createPublicSecurityScan(bundle.scan), null, 2)}\n`,
	);
}

async function readJsonFile(filePath: string): Promise<unknown> {
	return JSON.parse(await Bun.file(filePath).text()) as unknown;
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
	try {
		return await Bun.file(filePath).text();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

export class SecurityStore {
	readonly #repositoryRoot: string;
	readonly #projectKey: string;
	readonly #projectDirectory: string;

	constructor(repositoryRoot: string, projectKey: string, projectDirectory: string) {
		this.#repositoryRoot = repositoryRoot;
		this.#projectKey = projectKey;
		this.#projectDirectory = projectDirectory;
	}

	static async open(repositoryRoot: string, options: SecurityStoreOptions = {}): Promise<SecurityStore> {
		const canonicalRoot = await fs.realpath(path.resolve(repositoryRoot)).catch(() => path.resolve(repositoryRoot));
		const projectKey = encodeSecurityProjectKey(canonicalRoot);
		const projectDirectory = options.stateRoot
			? path.join(path.resolve(options.stateRoot), projectKey)
			: getSecurityProjectDir(projectKey);
		await ensurePrivateDirectory(projectDirectory);
		const store = new SecurityStore(canonicalRoot, projectKey, projectDirectory);
		await withSecurityStoreWrite(projectDirectory, () => store.#ensureIndex());
		return store;
	}

	static async openForCwd(cwd: string, options: SecurityStoreOptions = {}): Promise<SecurityStore> {
		const resolvedCwd = path.resolve(cwd);
		options.signal?.throwIfAborted();
		const repositoryRoot = vcs.repo(resolvedCwd)?.root() ?? resolvedCwd;
		return SecurityStore.open(repositoryRoot, options);
	}

	get repositoryRoot(): string {
		return this.#repositoryRoot;
	}

	get projectKey(): string {
		return this.#projectKey;
	}

	get projectDirectory(): string {
		return this.#projectDirectory;
	}

	#scanDirectory(scanId: string): string {
		if (!/^secscan_[a-zA-Z0-9]+$/.test(scanId)) throw new Error(`Invalid security scan id: ${scanId}`);
		return path.join(this.#projectDirectory, "scans", scanId);
	}

	#planPath(planId: string): string {
		if (!/^secplan_[a-zA-Z0-9]+$/.test(planId)) throw new Error(`Invalid security plan id: ${planId}`);
		return path.join(this.#projectDirectory, "plans", `${planId}.json`);
	}

	#indexPath(): string {
		return path.join(this.#projectDirectory, "index.json");
	}

	async #ensureIndex(): Promise<void> {
		try {
			await this.#readIndex();
		} catch (error) {
			if (!isEnoent(error)) throw error;
			await this.#writeIndex({
				schemaVersion: STORE_SCHEMA_VERSION,
				projectKey: this.#projectKey,
				repositoryRoot: this.#repositoryRoot,
				scanIds: [],
				planIds: [],
				updatedAt: new Date().toISOString(),
			});
		}
	}

	async #readIndex(): Promise<SecurityStoreIndex> {
		const value = (await readJsonFile(this.#indexPath())) as Partial<SecurityStoreIndex>;
		if (value.schemaVersion !== STORE_SCHEMA_VERSION || value.projectKey !== this.#projectKey) {
			throw new Error(`Unsupported security store index at ${this.#indexPath()}`);
		}
		if (!Array.isArray(value.scanIds) || !value.scanIds.every(id => typeof id === "string")) {
			throw new Error(`Invalid security store scan index at ${this.#indexPath()}`);
		}
		if (
			value.planIds !== undefined &&
			(!Array.isArray(value.planIds) || !value.planIds.every(id => typeof id === "string"))
		) {
			throw new Error(`Invalid security store plan index at ${this.#indexPath()}`);
		}
		return { ...value, planIds: value.planIds ?? [] } as SecurityStoreIndex;
	}

	async #writeIndex(index: SecurityStoreIndex): Promise<void> {
		await writeSecurityFileAtomic(this.#indexPath(), `${JSON.stringify(index, null, 2)}\n`);
	}

	async #putBundleUnlocked(input: SecurityScanBundle): Promise<void> {
		const bundle = parseSecurityScanBundle(input);
		if (bundle.scan.projectKey !== this.#projectKey) {
			throw new Error(`Security scan project key ${bundle.scan.projectKey} does not match ${this.#projectKey}`);
		}
		const scanDirectory = this.#scanDirectory(bundle.scan.id);
		await ensurePrivateDirectory(scanDirectory);
		await writeSecurityFileAtomic(
			path.join(scanDirectory, "findings.json"),
			`${JSON.stringify(bundle.findings, null, 2)}\n`,
		);
		if (bundle.report !== undefined) {
			await writeSecurityFileAtomic(path.join(scanDirectory, "report.md"), bundle.report);
		} else {
			await fs.rm(path.join(scanDirectory, "report.md"), { force: true });
		}
		if (bundle.sarif !== undefined) {
			await writeSecurityFileAtomic(
				path.join(scanDirectory, "results.sarif"),
				`${JSON.stringify(bundle.sarif, null, 2)}\n`,
			);
		} else {
			await fs.rm(path.join(scanDirectory, "results.sarif"), { force: true });
		}
		// The scan manifest is the commit marker: readers never observe it before
		// its findings and optional artifacts have been written atomically.
		await writeSecurityFileAtomic(path.join(scanDirectory, "scan.json"), `${JSON.stringify(bundle.scan, null, 2)}\n`);
		const index = await this.#readIndex();
		if (!index.scanIds.includes(bundle.scan.id)) index.scanIds.push(bundle.scan.id);
		index.updatedAt = new Date().toISOString();
		await this.#writeIndex(index);
	}

	async putBundle(input: SecurityScanBundle): Promise<void> {
		await withSecurityStoreWrite(this.#projectDirectory, () => this.#putBundleUnlocked(input));
	}

	async putPlan(input: SecurityScanPlan): Promise<void> {
		await withSecurityStoreWrite(this.#projectDirectory, async () => {
			const plan = parseSecurityScanPlan(input);
			if (plan.repositoryRoot !== this.#repositoryRoot) {
				throw new Error(`Security plan repository ${plan.repositoryRoot} does not match ${this.#repositoryRoot}`);
			}
			await writeSecurityFileAtomic(this.#planPath(plan.id), `${JSON.stringify(plan, null, 2)}\n`);
			const index = await this.#readIndex();
			if (!index.planIds.includes(plan.id)) index.planIds.push(plan.id);
			index.updatedAt = new Date().toISOString();
			await this.#writeIndex(index);
		});
	}

	async getPlan(planId: string): Promise<SecurityScanPlan | null> {
		try {
			return parseSecurityScanPlan(await readJsonFile(this.#planPath(planId)));
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}
	}

	async listPlans(): Promise<SecurityScanPlan[]> {
		const index = await this.#readIndex();
		const plans: SecurityScanPlan[] = [];
		for (const planId of [...index.planIds].reverse()) {
			const plan = await this.getPlan(planId);
			if (plan) plans.push(plan);
		}
		return plans;
	}

	async getScan(scanId: string): Promise<SecurityScan | null> {
		try {
			return parseSecurityScan(await readJsonFile(path.join(this.#scanDirectory(scanId), "scan.json")));
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}
	}

	async #getBundleUnlocked(scanId: string): Promise<SecurityScanBundle | null> {
		const scan = await this.getScan(scanId);
		if (!scan) return null;
		const rawFindings = await readJsonFile(path.join(this.#scanDirectory(scanId), "findings.json"));
		if (!Array.isArray(rawFindings)) throw new Error(`Invalid findings list for ${scanId}`);
		const findings = rawFindings.map(parseSecurityFinding);
		const report = await readOptionalText(path.join(this.#scanDirectory(scanId), "report.md"));
		const sarifText = await readOptionalText(path.join(this.#scanDirectory(scanId), "results.sarif"));
		const bundle: SecurityScanBundle = { scan, findings };
		if (report !== undefined) bundle.report = report;
		if (sarifText !== undefined) bundle.sarif = JSON.parse(sarifText) as Record<string, unknown>;
		return parseSecurityScanBundle(bundle);
	}

	async getBundle(scanId: string): Promise<SecurityScanBundle | null> {
		return withSecurityStoreWrite(this.#projectDirectory, () => this.#getBundleUnlocked(scanId));
	}

	async listScans(): Promise<SecurityScanSummary[]> {
		const index = await this.#readIndex();
		const summaries: SecurityScanSummary[] = [];
		for (const scanId of [...index.scanIds].reverse()) {
			const bundle = await this.getBundle(scanId);
			if (!bundle) continue;
			summaries.push({
				id: bundle.scan.id,
				status: bundle.scan.status,
				createdAt: bundle.scan.createdAt,
				completedAt: bundle.scan.completedAt,
				producer: bundle.scan.producer,
				findingCount: bundle.findings.length,
				target: bundle.scan.target,
			});
		}
		return summaries;
	}

	async getFinding(scanId: string, findingId: string): Promise<SecurityFinding | null> {
		const bundle = await this.getBundle(scanId);
		return bundle?.findings.find(finding => finding.id === findingId) ?? null;
	}

	async updateDisposition(
		scanId: string,
		findingId: string,
		disposition: SecurityDisposition,
	): Promise<SecurityFinding> {
		return withSecurityStoreWrite(this.#projectDirectory, async () => {
			const bundle = await this.#getBundleUnlocked(scanId);
			if (!bundle) throw new Error(`Unknown security scan: ${scanId}`);
			const index = bundle.findings.findIndex(finding => finding.id === findingId);
			if (index < 0) throw new Error(`Unknown security finding: ${findingId}`);
			const canonicalDisposition: SecurityDisposition = { status: disposition.status };
			if (disposition.rationale !== undefined) canonicalDisposition.rationale = disposition.rationale;
			if (disposition.updatedAt !== undefined) canonicalDisposition.updatedAt = disposition.updatedAt;
			if (disposition.actor !== undefined) canonicalDisposition.actor = disposition.actor;
			const updated = { ...bundle.findings[index], disposition: canonicalDisposition };
			bundle.findings[index] = parseSecurityFinding(updated);
			if (bundle.sarif !== undefined) bundle.sarif = exportSecurityBundleToSarif(bundle);
			await this.#putBundleUnlocked(bundle);
			return bundle.findings[index];
		});
	}

	async updateValidation(
		scanId: string,
		findingId: string,
		validation: SecurityValidation,
		evidence: readonly SecurityEvidence[] = [],
	): Promise<SecurityFinding> {
		return withSecurityStoreWrite(this.#projectDirectory, async () => {
			const bundle = await this.#getBundleUnlocked(scanId);
			if (!bundle) throw new Error(`Unknown security scan: ${scanId}`);
			const index = bundle.findings.findIndex(finding => finding.id === findingId);
			if (index < 0) throw new Error(`Unknown security finding: ${findingId}`);
			const finding = bundle.findings[index];
			const evidenceById = new Map(finding.evidence.map(item => [item.id, item]));
			for (const item of evidence) evidenceById.set(item.id, item);
			const canonicalValidation: SecurityValidation = {
				status: validation.status,
				evidenceIds: [...new Set(validation.evidenceIds)],
			};
			if (validation.summary !== undefined) canonicalValidation.summary = validation.summary;
			if (validation.validatedAt !== undefined) canonicalValidation.validatedAt = validation.validatedAt;
			for (const evidenceId of canonicalValidation.evidenceIds) {
				if (!evidenceById.has(evidenceId)) {
					throw new Error(`Unknown security validation evidence: ${evidenceId}`);
				}
			}
			bundle.findings[index] = parseSecurityFinding({
				...finding,
				evidence: [...evidenceById.values()],
				validation: canonicalValidation,
			});
			if (bundle.sarif !== undefined) bundle.sarif = exportSecurityBundleToSarif(bundle);
			await this.#putBundleUnlocked(bundle);
			return bundle.findings[index];
		});
	}

	async compare(beforeScanId: string, afterScanId: string): Promise<SecurityComparisonReport> {
		const before = await this.getBundle(beforeScanId);
		const after = await this.getBundle(afterScanId);
		if (!before) throw new Error(`Unknown security scan: ${beforeScanId}`);
		if (!after) throw new Error(`Unknown security scan: ${afterScanId}`);
		return compareSecurityLineage(before, after);
	}

	async storeDigest(): Promise<string> {
		const index = await this.#readIndex();
		return Bun.SHA256.hash(JSON.stringify(index), "hex");
	}
}
