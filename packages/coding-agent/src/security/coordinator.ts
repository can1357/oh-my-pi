import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { AsyncJobManager } from "../async/job-manager";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { ToolDefinition } from "../extensibility/extensions";
import securityReviewerPrompt from "../prompts/agents/security-reviewer.md" with { type: "text" };
import securityCoordinatorPrompt from "../prompts/security/scan-coordinator.md" with { type: "text" };
import securityRequestPrompt from "../prompts/security/scan-request.md" with { type: "text" };
import securityPublishDescription from "../prompts/tools/security-publish.md" with { type: "text" };
import { createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import type { AuthStorage } from "../session/auth-storage";
import { SessionManager } from "../session/session-manager";
import { createExactSecurityOAuthResolver, selectSecurityAccount } from "./auth";
import type {
	SecurityCoverage,
	SecurityModelRef,
	SecurityScan,
	SecurityScanBundle,
	SecurityScanPlan,
	SecurityTargetKind,
} from "./contracts";
import { createSecurityScanId } from "./contracts";
import type { SecurityGitAdapter, SecurityTargetRequest } from "./preflight";
import {
	assertSecurityScanPlanFresh,
	createSecurityScanPlan,
	DEFAULT_SECURITY_GIT_ADAPTER,
	prepareSecurityOutputDirectory,
} from "./preflight";
import {
	createNativeSecurityProducer,
	createNativeSecurityProvenance,
	createSecurityWorkflowFingerprint,
} from "./provenance";
import { createSecurityPublicationTool } from "./publication";
import { SecurityStore, writeSecurityBundleToDirectory } from "./store";

const SECURITY_SESSION_TOOLS = ["read", "grep", "glob", "lsp", "ast_grep", "task", "security_publish"];
const SECURITY_WORKFLOW_FINGERPRINT = createSecurityWorkflowFingerprint([
	securityCoordinatorPrompt,
	securityRequestPrompt,
	securityReviewerPrompt,
	securityPublishDescription,
]);

export type SecurityOperationPhase =
	| "queued"
	| "preparing"
	| "reviewing"
	| "publishing"
	| "completed"
	| "partial"
	| "cancelled"
	| "failed";

export interface SecurityOperationSnapshot {
	operationId: string;
	planId: string;
	scanId: string;
	phase: SecurityOperationPhase;
	createdAt: string;
	updatedAt: string;
	jobId?: string;
	sessionFile?: string;
	findingCount: number;
	error?: string;
}

export interface SecurityCoordinatorHost {
	cwd: string;
	settings: Settings;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	activeModel?: Model;
	sessionId?: string;
	agentId?: string;
	asyncJobManager?: AsyncJobManager;
}

export interface SecurityPreflightInput {
	target?: SecurityTargetRequest;
	knowledgeBasePaths?: string[];
	outputRoot?: string;
	archiveExisting?: boolean;
	credentialId?: number;
	model?: Model;
	thinkingLevel?: string;
	signal?: AbortSignal;
}

export interface SecurityStartInput {
	planId: string;
}

export interface SecurityScanSession {
	prompt(
		text: string,
		options?: { expandPromptTemplates?: boolean; synthetic?: boolean; userInitiated?: boolean },
	): Promise<boolean>;
	waitForIdle(): Promise<void>;
	getSessionStats?(): {
		tokens: {
			input: number;
			output: number;
			reasoning: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
		cost: number;
		premiumRequests: number;
	};
	abort(options?: { reason?: string }): Promise<void>;
	dispose(): Promise<void>;
	readonly sessionFile?: string;
}

export interface SecurityScanSessionFactoryInput {
	host: SecurityCoordinatorHost;
	plan: SecurityScanPlan;
	executionRoot: string;
	scanId: string;
	model: Model;
	publicationTool: ToolDefinition;
	sessionManager: SessionManager;
}

export type SecurityScanSessionFactory = (input: SecurityScanSessionFactoryInput) => Promise<SecurityScanSession>;

export interface SecurityCoordinatorDependencies {
	createSession?: SecurityScanSessionFactory;
	openStore?: (repositoryRoot: string) => Promise<SecurityStore>;
	gitAdapter?: SecurityGitAdapter;
	now?: () => Date;
	createOperationId?: () => string;
}

interface SecurityOperationRecord {
	snapshot: SecurityOperationSnapshot;
	promise: Promise<void>;
	abortController?: AbortController;
}

function toIsoTimestamp(now: () => Date): string {
	return now().toISOString();
}

function securityConfigSnapshot(settings: Settings): Record<string, boolean> {
	return { securityEnabled: settings.get("security.enabled") };
}

function createOperationId(): string {
	return `secop_${Bun.randomUUIDv7().replaceAll("-", "")}`;
}

function mapCoverageMode(targetKind: SecurityTargetKind): SecurityCoverage["mode"] {
	switch (targetKind) {
		case "ref_diff":
			return "diff";
		case "working_tree":
			return "working_tree";
		case "scoped_path":
			return "scoped_path";
		case "imported":
			return "imported";
		default:
			return "repository";
	}
}

function initialCoverage(plan: SecurityScanPlan): SecurityCoverage {
	return {
		mode: mapCoverageMode(plan.target.kind),
		completeness: "unknown",
		inventoryStrategy:
			plan.target.kind === "ref_diff" ? "diff" : plan.target.kind === "scoped_path" ? "scoped_path" : "repository",
		includePaths: plan.target.includePaths,
		excludePaths: plan.target.excludePaths,
		surfaces: [],
		explicitExclusions: [],
		deferred: [{ id: "scan-pending", reason: "Security review has not completed" }],
	};
}

function initialBundle(
	store: SecurityStore,
	plan: SecurityScanPlan,
	scanId: string,
	operationId: string,
	startedAt: string,
	status: SecurityScan["status"] = "running",
): SecurityScanBundle {
	const producer = createNativeSecurityProducer();
	const provenance = createNativeSecurityProvenance({
		createdAt: startedAt,
		account: plan.account,
		planFingerprint: plan.fingerprint,
		operationId,
		workflowFingerprint: plan.workflowFingerprint,
	});
	return {
		scan: {
			documentType: "omp-security.scan",
			schemaVersion: "1.0",
			id: scanId,
			projectKey: store.projectKey,
			status,
			createdAt: plan.createdAt,
			startedAt,
			plan,
			target: plan.target,
			producer,
			provenance,
			findingIds: [],
			coverage: initialCoverage(plan),
		},
		findings: [],
	};
}

async function createDefaultSecuritySession(input: SecurityScanSessionFactoryInput): Promise<AgentSession> {
	const scanSettings = await input.host.settings.cloneForCwd(input.executionRoot);
	const modelSelector = `${input.model.provider}/${input.model.id}`;
	scanSettings.override("retry.modelFallback", false);
	scanSettings.override("retry.usageAwareFallback", false);
	scanSettings.override("retry.fallbackChains", {});
	scanSettings.override("task.agentModelOverrides", {
		...scanSettings.get("task.agentModelOverrides"),
		"security-reviewer": modelSelector,
	});
	scanSettings.override("task.agentPrewalk", {
		...scanSettings.get("task.agentPrewalk"),
		"security-reviewer": "off",
	});
	const { session } = await createAgentSession({
		cwd: input.executionRoot,
		authStorage: input.host.authStorage,
		modelRegistry: input.host.modelRegistry,
		settings: scanSettings,
		model: input.model,
		getApiKey: createExactSecurityOAuthResolver({
			authStorage: input.host.authStorage,
			account: input.plan.account,
		}),
		providerSessionId: `security:${input.scanId}`,
		sessionManager: input.sessionManager,
		customTools: [input.publicationTool],
		toolNames: SECURITY_SESSION_TOOLS,
		restrictToolNames: true,
		allowRestrictedCustomTools: true,
		spawns: "security-reviewer",
		appendSystemPrompt: securityCoordinatorPrompt.trim(),
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableIrc: false,
		enableLsp: true,
		lspReadOnly: true,
		hasUI: false,
		autoApprove: true,
		skipPythonPreflight: true,
		agentId: `Security-${input.scanId.slice(-12)}`,
		agentDisplayName: "security",
	});
	return session;
}

function requestText(plan: SecurityScanPlan, executionRoot: string, diffText?: string): string {
	return prompt
		.render(securityRequestPrompt, {
			repositoryRoot: executionRoot,
			targetKind: plan.target.kind,
			revision: plan.target.revision ?? "",
			baseRevision: plan.target.baseRevision ?? "",
			headRevision: plan.target.headRevision ?? "",
			includePaths: plan.target.includePaths.length > 0 ? plan.target.includePaths.join(", ") : "all in-scope paths",
			excludePaths: plan.target.excludePaths.length > 0 ? plan.target.excludePaths.join(", ") : "none",
			knowledgeBases:
				plan.knowledgeBases.length > 0 ? plan.knowledgeBases.map(item => item.path).join(", ") : "none",
			planFingerprint: plan.fingerprint,
			diffText: diffText ?? "",
		})
		.trim();
}

function terminalText(snapshot: SecurityOperationSnapshot): string {
	return [
		`Security scan ${snapshot.scanId}: ${snapshot.phase}.`,
		`Operation: ${snapshot.operationId}`,
		`Plan: ${snapshot.planId}`,
		`Findings: ${snapshot.findingCount}`,
		snapshot.error ? `Error: ${snapshot.error}` : undefined,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

interface PreparedSecurityExecutionTarget {
	cwd: string;
	diffText?: string;
	cleanup(): Promise<void>;
}

const ACTIVE_SECURITY_OPERATIONS = new Set<string>();

function operationIdFromBundle(bundle: SecurityScanBundle): string | undefined {
	const value = bundle.scan.provenance.metadata?.operationId;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function operationPhaseFromStatus(status: SecurityScan["status"]): SecurityOperationPhase {
	return status === "running" || status === "planned" ? "failed" : status;
}

async function tryRemoveWorktree(repo: VcsGitRepo | null, cwd: string): Promise<boolean> {
	if (!repo) return false;
	try {
		return await repo.worktreeRemove(cwd, true);
	} catch {
		return false;
	}
}

async function prepareSecurityExecutionTarget(
	plan: SecurityScanPlan,
	store: SecurityStore,
	scanId: string,
	adapter: SecurityGitAdapter,
	signal: AbortSignal,
): Promise<PreparedSecurityExecutionTarget> {
	if (plan.target.kind !== "ref_diff") {
		return { cwd: plan.repositoryRoot, cleanup: async () => undefined };
	}
	const headRevision = plan.target.headRevision;
	const baseRevision = plan.target.baseRevision;
	if (!headRevision || !baseRevision) throw new Error("ref_diff security plan is missing resolved revisions");
	const targetsRoot = path.join(store.projectDirectory, "targets");
	await fs.mkdir(targetsRoot, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") await fs.chmod(targetsRoot, 0o700);
	const cwd = path.join(targetsRoot, scanId);
	const repo = vcs.requireGit(plan.repositoryRoot);
	let added = false;
	try {
		await repo.worktreeAdd(cwd, headRevision, { detach: true, clone: false }, signal);
		added = true;
		const diffText = await adapter.diffTree(plan.repositoryRoot, baseRevision, headRevision, signal);
		return {
			cwd,
			diffText,
			async cleanup() {
				const removed = await tryRemoveWorktree(repo, cwd);
				if (!removed) await fs.rm(cwd, { recursive: true, force: true });
			},
		};
	} catch (error) {
		if (added) await tryRemoveWorktree(repo, cwd);
		await fs.rm(cwd, { recursive: true, force: true });
		throw error;
	}
}

export class SecurityCoordinator {
	readonly #host: SecurityCoordinatorHost;
	readonly #createSession: SecurityScanSessionFactory;
	readonly #openStore: (repositoryRoot: string) => Promise<SecurityStore>;
	readonly #gitAdapter: SecurityGitAdapter;
	readonly #now: () => Date;
	readonly #createOperationId: () => string;
	readonly #operations = new Map<string, SecurityOperationRecord>();
	#recovery?: Promise<void>;

	constructor(host: SecurityCoordinatorHost, dependencies: SecurityCoordinatorDependencies = {}) {
		this.#host = host;
		this.#createSession = dependencies.createSession ?? createDefaultSecuritySession;
		this.#openStore = dependencies.openStore ?? (cwd => SecurityStore.openForCwd(cwd));
		this.#gitAdapter = dependencies.gitAdapter ?? DEFAULT_SECURITY_GIT_ADAPTER;
		this.#now = dependencies.now ?? (() => new Date());
		this.#createOperationId = dependencies.createOperationId ?? createOperationId;
	}
	async #ensureRecovered(): Promise<void> {
		this.#recovery ??= this.#recoverInterruptedOperations();
		await this.#recovery;
	}

	async #recoverInterruptedOperations(): Promise<void> {
		const store = await this.#openStore(this.#host.cwd);
		for (const summary of await store.listScans()) {
			const bundle = await store.getBundle(summary.id);
			if (!bundle) continue;
			const operationId = operationIdFromBundle(bundle);
			if (!operationId || this.#operations.has(operationId) || ACTIVE_SECURITY_OPERATIONS.has(operationId)) continue;
			if (bundle.scan.status === "running" || bundle.scan.status === "planned") {
				const message = "Security scan was interrupted by a process restart";
				bundle.scan.status = "failed";
				bundle.scan.completedAt = toIsoTimestamp(this.#now);
				bundle.scan.error = message;
				await store.putBundle(bundle);
				if (bundle.scan.target.kind === "ref_diff") {
					const targetPath = path.join(store.projectDirectory, "targets", bundle.scan.id);
					await tryRemoveWorktree(vcs.git(bundle.scan.target.repositoryRoot), targetPath);
					await fs.rm(targetPath, { recursive: true, force: true });
				}
			}
			const snapshot: SecurityOperationSnapshot = {
				operationId,
				planId: bundle.scan.plan?.id ?? "",
				scanId: bundle.scan.id,
				phase: operationPhaseFromStatus(bundle.scan.status),
				createdAt: bundle.scan.createdAt,
				updatedAt: bundle.scan.completedAt ?? bundle.scan.startedAt ?? bundle.scan.createdAt,
				findingCount: bundle.findings.length,
			};
			if (bundle.scan.error !== undefined) snapshot.error = bundle.scan.error;
			this.#operations.set(operationId, { snapshot, promise: Promise.resolve() });
		}
	}

	async preflight(input: SecurityPreflightInput = {}): Promise<SecurityScanPlan> {
		if (!this.#host.settings.get("security.enabled")) {
			throw new Error("Security is disabled; enable security.enabled before planning a scan");
		}
		const model = input.model ?? this.#host.activeModel;
		if (!model) throw new Error("Security scan preflight requires an active model");
		const account = selectSecurityAccount(
			this.#host.authStorage,
			model.provider,
			input.credentialId,
			this.#host.sessionId,
		);
		const store = await this.#openStore(this.#host.cwd);
		const workRoot = path.join(store.projectDirectory, "work");
		await fs.mkdir(workRoot, { recursive: true, mode: 0o700 });
		if (process.platform !== "win32") await fs.chmod(workRoot, 0o700);
		const modelRef: SecurityModelRef = { provider: model.provider, modelId: model.id };
		if (input.thinkingLevel !== undefined) modelRef.thinkingLevel = input.thinkingLevel;
		const plan = await createSecurityScanPlan(
			{
				cwd: this.#host.cwd,
				target: input.target ?? { kind: "repository" },
				knowledgeBasePaths: input.knowledgeBasePaths,
				outputRoot: input.outputRoot ?? path.join(workRoot, Bun.randomUUIDv7()),
				archiveExisting: input.archiveExisting,
				model: modelRef,
				account,
				config: securityConfigSnapshot(this.#host.settings),
				workflowFingerprint: SECURITY_WORKFLOW_FINGERPRINT,
				signal: input.signal,
			},
			this.#gitAdapter,
		);
		await store.putPlan(plan);
		return plan;
	}

	async start(input: SecurityStartInput): Promise<SecurityOperationSnapshot> {
		if (!this.#host.settings.get("security.enabled")) {
			throw new Error("Security is disabled; enable security.enabled before starting a scan");
		}
		await this.#ensureRecovered();
		const store = await this.#openStore(this.#host.cwd);
		const plan = await store.getPlan(input.planId);
		if (!plan) throw new Error(`Unknown security scan plan: ${input.planId}`);
		await assertSecurityScanPlanFresh(
			plan,
			{
				config: securityConfigSnapshot(this.#host.settings),
				workflowFingerprint: SECURITY_WORKFLOW_FINGERPRINT,
			},
			this.#gitAdapter,
		);
		const operationId = this.#createOperationId();
		const scanId = createSecurityScanId();
		const createdAt = toIsoTimestamp(this.#now);
		const snapshot: SecurityOperationSnapshot = {
			operationId,
			planId: plan.id,
			scanId,
			phase: "queued",
			createdAt,
			updatedAt: createdAt,
			findingCount: 0,
		};
		const record: SecurityOperationRecord = { snapshot, promise: Promise.resolve() };
		this.#operations.set(operationId, record);
		ACTIVE_SECURITY_OPERATIONS.add(operationId);
		const run = async (signal: AbortSignal, reportProgress?: (text: string) => Promise<void>): Promise<void> => {
			await this.#run(record, plan, store, signal, reportProgress);
		};
		const manager = this.#host.asyncJobManager;
		if (manager) {
			const jobId = manager.register(
				"task",
				`Security scan ${scanId}`,
				async ({ signal, reportProgress }) => {
					await run(signal, text => reportProgress(text, { operationId, scanId, phase: record.snapshot.phase }));
					return terminalText(record.snapshot);
				},
				{ id: operationId, ownerId: this.#host.agentId },
			);
			record.snapshot.jobId = jobId;
			record.promise = manager.getJob(jobId)?.promise ?? Promise.resolve();
		} else {
			const abortController = new AbortController();
			record.abortController = abortController;
			record.promise = run(abortController.signal);
		}
		return { ...record.snapshot };
	}

	async status(operationId: string): Promise<SecurityOperationSnapshot | null> {
		await this.#ensureRecovered();
		let record = this.#operations.get(operationId);
		if (!record && !ACTIVE_SECURITY_OPERATIONS.has(operationId)) {
			// The operation may have run under another session's coordinator; once it
			// is terminal its bundle is on disk, so rescan before reporting unknown.
			await this.#recoverInterruptedOperations();
			record = this.#operations.get(operationId);
		}
		return record ? { ...record.snapshot } : null;
	}

	async listOperations(): Promise<SecurityOperationSnapshot[]> {
		await this.#ensureRecovered();
		return [...this.#operations.values()]
			.map(record => ({ ...record.snapshot }))
			.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	}

	async cancel(operationId: string): Promise<boolean> {
		await this.#ensureRecovered();
		const record = this.#operations.get(operationId);
		if (!record) return false;
		if (["completed", "partial", "cancelled", "failed"].includes(record.snapshot.phase)) return false;
		if (record.snapshot.jobId && this.#host.asyncJobManager) {
			return this.#host.asyncJobManager.cancel(record.snapshot.jobId, { ownerId: this.#host.agentId });
		}
		record.abortController?.abort(new Error("Security scan cancelled"));
		return true;
	}

	async wait(operationId: string): Promise<SecurityOperationSnapshot> {
		await this.#ensureRecovered();
		const record = this.#operations.get(operationId);
		if (!record) throw new Error(`Unknown security operation: ${operationId}`);
		await record.promise;
		return { ...record.snapshot };
	}

	#update(record: SecurityOperationRecord, phase: SecurityOperationPhase, error?: string): void {
		record.snapshot.phase = phase;
		record.snapshot.updatedAt = toIsoTimestamp(this.#now);
		record.snapshot.error = error;
	}

	async #run(
		record: SecurityOperationRecord,
		plan: SecurityScanPlan,
		store: SecurityStore,
		signal: AbortSignal,
		reportProgress?: (text: string) => Promise<void>,
	): Promise<void> {
		const startedAt = toIsoTimestamp(this.#now);
		let session: SecurityScanSession | undefined;
		let publishedBundle: SecurityScanBundle | undefined;
		let executionTarget: PreparedSecurityExecutionTarget | undefined;
		try {
			await store.putBundle(
				initialBundle(store, plan, record.snapshot.scanId, record.snapshot.operationId, startedAt),
			);
			if (signal.aborted) throw signal.reason ?? new Error("Security scan cancelled");
			await prepareSecurityOutputDirectory(plan.output, record.snapshot.scanId);
			this.#update(record, "preparing");
			await reportProgress?.("Preparing OMP-native security scan");
			executionTarget = await prepareSecurityExecutionTarget(
				plan,
				store,
				record.snapshot.scanId,
				this.#gitAdapter,
				signal,
			);
			const activeModel = this.#host.activeModel;
			const model =
				activeModel?.provider === plan.model.provider && activeModel.id === plan.model.modelId
					? activeModel
					: this.#host.modelRegistry.find(plan.model.provider, plan.model.modelId);
			if (!model)
				throw new Error(`Security scan model is unavailable: ${plan.model.provider}/${plan.model.modelId}`);
			const sessionsDirectory = path.join(store.projectDirectory, "sessions");
			await fs.mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
			const sessionManager = SessionManager.create(executionTarget.cwd, sessionsDirectory);
			const publicationTool = createSecurityPublicationTool({
				plan,
				scanId: record.snapshot.scanId,
				store,
				startedAt,
				sessionId: `security:${record.snapshot.scanId}`,
				operationId: record.snapshot.operationId,
				onPublished: async bundle => {
					publishedBundle = bundle;
					record.snapshot.findingCount = bundle.findings.length;
					this.#update(record, "publishing");
				},
			});
			session = await this.#createSession({
				host: this.#host,
				plan,
				scanId: record.snapshot.scanId,
				executionRoot: executionTarget.cwd,
				model,
				// Bare `ToolDefinition` erases the concrete schema; the sdk.ts
				// `as unknown as CustomTool` precedent applies to the same variance wall.
				publicationTool: publicationTool as unknown as ToolDefinition,
				sessionManager,
			});
			record.snapshot.sessionFile = session.sessionFile;
			const abortSession = (): void => {
				void session?.abort({ reason: "Security scan cancelled" });
			};
			signal.addEventListener("abort", abortSession, { once: true });
			try {
				if (signal.aborted) throw signal.reason ?? new Error("Security scan cancelled");
				this.#update(record, "reviewing");
				await reportProgress?.("Reviewing repository with OMP security workers");
				await session.prompt(requestText(plan, executionTarget.cwd, executionTarget.diffText), {
					expandPromptTemplates: false,
					synthetic: true,
					userInitiated: false,
				});
				await session.waitForIdle();
				record.snapshot.sessionFile = session.sessionFile;
				if (publishedBundle) {
					const stats = session.getSessionStats?.();
					publishedBundle.scan.metrics = {
						runtimeMs: Math.max(0, this.#now().getTime() - new Date(startedAt).getTime()),
						...(stats
							? {
									tokenUsage: { ...stats.tokens },
									cost: stats.cost,
									premiumRequests: stats.premiumRequests,
								}
							: {}),
					};
					await writeSecurityBundleToDirectory(plan.output.root, publishedBundle);
					await store.putBundle(publishedBundle);
				}
			} finally {
				signal.removeEventListener("abort", abortSession);
			}
			if (signal.aborted) throw signal.reason ?? new Error("Security scan cancelled");
			if (publishedBundle) {
				this.#update(record, "completed");
				await reportProgress?.(`Published ${publishedBundle.findings.length} security finding(s)`);
				return;
			}
			const partial = initialBundle(
				store,
				plan,
				record.snapshot.scanId,
				record.snapshot.operationId,
				startedAt,
				"partial",
			);
			partial.scan.completedAt = toIsoTimestamp(this.#now);
			partial.scan.error = "The scan session ended without publishing a canonical result";
			this.#update(record, "partial", partial.scan.error);
			await store.putBundle(partial);
		} catch (error) {
			if (publishedBundle) {
				// The canonical bundle is already persisted by security_publish; a late
				// failure (metrics/output-directory write) degrades, not invalidates it.
				logger.warn("Security scan post-publication step failed", {
					scanId: record.snapshot.scanId,
					error: error instanceof Error ? error.message : String(error),
				});
				record.snapshot.findingCount = publishedBundle.findings.length;
				this.#update(record, "completed");
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			const cancelled = signal.aborted;
			const terminal = initialBundle(
				store,
				plan,
				record.snapshot.scanId,
				record.snapshot.operationId,
				startedAt,
				cancelled ? "cancelled" : "failed",
			);
			terminal.scan.completedAt = toIsoTimestamp(this.#now);
			terminal.scan.error = message;
			this.#update(record, cancelled ? "cancelled" : "failed", message);
			await store.putBundle(terminal);
		} finally {
			await session?.dispose().catch(() => undefined);
			await executionTarget?.cleanup().catch(() => undefined);
			ACTIVE_SECURITY_OPERATIONS.delete(record.snapshot.operationId);
		}
	}
}

const COORDINATORS = new Map<string, SecurityCoordinator>();

export function getSecurityCoordinator(host: SecurityCoordinatorHost): SecurityCoordinator {
	const key = `${path.resolve(host.cwd)}\u0000${host.sessionId ?? "sessionless"}`;
	const existing = COORDINATORS.get(key);
	if (existing) return existing;
	const coordinator = new SecurityCoordinator(host);
	COORDINATORS.set(key, coordinator);
	return coordinator;
}

export function resetSecurityCoordinatorsForTests(): void {
	COORDINATORS.clear();
}
