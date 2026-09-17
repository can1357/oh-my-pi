import * as fs from "node:fs/promises";
import path from "node:path";
import { type } from "arktype";
import { Settings } from "../config/settings";
import { createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { delegatedIoToolNames, isPathWithinWorkspace } from "../session/delegated-io";
import { SessionManager } from "../session/session-manager";
import { type CodeWriteReceipt, observeCodeWrite } from "../task/code-write";
import { projectDelegatedIoResult } from "../task/delegated-output";
import { integrateTaskResult } from "../task/integration";
import type { SingleResult, TaskToolDetails } from "../task/types";
import type { WorktreeBaseline } from "../task/worktree";
import { acquireNativeTaskIntegrationLock } from "./native-task-lock";
import {
	type NativeTaskCheckpoint,
	type NativeTaskJobPayload,
	nativeTaskJson,
	parseNativeTaskCheckpoint,
	parseNativeTaskDefinition,
	parseNativeTaskJobPayload,
	parseNativeTaskPolicy,
} from "./native-task-payload";
import type { JobExecutor, JobExecutorContext } from "./runner";
import type { OperationalStore } from "./store";
import type { JsonValue } from "./types";

export type { NativeTaskJobPayload } from "./native-task-payload";
export { parseNativeTaskJobPayload } from "./native-task-payload";

export interface NativeTaskExecutorOptions {
	store: OperationalStore;
	artifactsDir: string;
	heartbeatIntervalMs?: number;
	createSession?: typeof createAgentSession;
}

export interface NativeTaskReceipt {
	kind: "native-task";
	agentId: string;
	output: string;
	exitCode: number;
	changesApplied: boolean;
	mergeSummary: string;
	artifacts: string[];
	outputPath: string;
	branchName: string | null;
}
const receiptSchema = type({
	kind: "'native-task'",
	agentId: "string > 0",
	output: "string",
	exitCode: "number.integer >= 0",
	changesApplied: "boolean",
	mergeSummary: "string",
	artifacts: "string[]",
	outputPath: "string",
	branchName: "string|null",
});
export function parseNativeTaskReceipt(value: JsonValue): NativeTaskReceipt {
	const result = receiptSchema.assert(value);
	if (new TextEncoder().encode(result.output).byteLength > 12_000)
		throw new Error("Malformed native task receipt: output exceeds bound.");
	return result;
}

function parseCodeReceipt(value: unknown, target: string, integrated: boolean): CodeWriteReceipt {
	const receipt = type({
		kind: "'code-write'",
		target: "string > 0",
		lines: "number.integer > 0",
		bytes: "number.integer > 0",
		sha256: "string",
		changesApplied: "boolean",
	}).assert(value);
	if (
		Object.keys(receipt).length !== 6 ||
		receipt.target !== target ||
		!/^[a-f0-9]{64}$/.test(receipt.sha256) ||
		receipt.changesApplied !== integrated
	) {
		throw new Error("Malformed native codeWrite receipt.");
	}
	return receipt;
}

export interface NativeTaskRuntime {
	payload: NativeTaskJobPayload;
	artifactsDir: string;
	checkpoint: NativeTaskCheckpoint;
	prepare(baseline: WorktreeBaseline | null): void;
	executing(isolationId: string | null): void;
	complete(result: SingleResult, baseline: WorktreeBaseline | null, receipt?: CodeWriteReceipt): Promise<void>;
}
const executions = new WeakMap<JobExecutorContext, NativeTaskRuntime>();
export function getNativeTaskRuntime(ctx: JobExecutorContext): NativeTaskRuntime {
	const runtime = executions.get(ctx);
	if (!runtime) throw new Error("Native task execution context was not registered by its durable executor.");
	return runtime;
}

function bounded(text: string, bytes = 8000): string {
	return new TextDecoder().decode(new TextEncoder().encode(text).subarray(0, bytes), { stream: true });
}

/** Initial and recovered jobs use this same SDK reconstruction and ordinary native task execute path. */
export function createNativeTaskExecutor(options: NativeTaskExecutorOptions): JobExecutor {
	if (!options.store || !path.isAbsolute(options.artifactsDir))
		throw new Error("Native task executor requires its runner's store and an absolute artifact root.");
	const interval = options.heartbeatIntervalMs ?? 10_000;
	if (!Number.isSafeInteger(interval) || interval < 1) throw new Error("Invalid native task heartbeat interval.");
	return async ctx => {
		const payload = parseNativeTaskJobPayload(ctx.job.payload);
		const stored = ctx.checkpoint === null ? null : parseNativeTaskCheckpoint(ctx.checkpoint);
		// Recovery dispatch precedes SDK construction and new-file validation.
		if (stored?.phase === "integrated") {
			const receipt = parseNativeTaskReceipt(stored.receipt);
			if (receipt.agentId !== payload.agentId || receipt.exitCode !== 0 || stored.integrationError)
				throw new Error("Malformed integrated native task receipt.");
			if (payload.params.codeWrite) {
				const code = type({ target: "string" }).assert(payload.params.codeWrite);
				parseCodeReceipt(JSON.parse(receipt.output), code.target, true);
				if (!receipt.changesApplied) throw new Error("Malformed integrated native codeWrite receipt.");
			}
			return nativeTaskJson(receipt);
		}
		if (stored?.phase === "integrating")
			throw new Error("Recovery requires reconciliation: integration was interrupted.");
		const definition = parseNativeTaskDefinition(payload.agentDefinition);
		const policy = parseNativeTaskPolicy(payload.policy);
		const contract = payload.params.codeWrite
			? "code-write"
			: payload.params.evidenceDigest
				? "evidence-digest"
				: undefined;
		const expectedTools = contract
			? delegatedIoToolNames(
					contract === "code-write"
						? { kind: "code-write", reference: "", target: "", workspaceRoot: "" }
						: { kind: "evidence-digest" },
				)
			: [];
		const restricted =
			contract &&
			definition.tools?.length === expectedTools.length &&
			expectedTools.every(name => definition.tools?.includes(name)) &&
			policy.toolProfile?.allowDiscovery === false &&
			policy.toolProfile.maximum.length === expectedTools.length &&
			expectedTools.every(name =>
				policy.toolProfile?.maximum.some(
					capability =>
						capability.name === name && capability.source === (name === "yield" ? "hidden" : "builtin"),
				),
			);
		if (stored && (stored.phase === "prepared" || stored.phase === "executing") && !restricted)
			throw new Error("Recovery requires reconciliation: interrupted unrestricted native task is not replay-safe.");
		const controller = new AbortController();
		const abort = () => controller.abort(ctx.signal.reason);
		ctx.signal.addEventListener("abort", abort, { once: true });
		if (ctx.signal.aborted) abort();
		const heartbeat = () => {
			if (controller.signal.aborted) return false;
			try {
				if (ctx.heartbeat()) return true;
				controller.abort(new Error("Native task lost its execution lease."));
			} catch (error) {
				controller.abort(error);
			}
			return false;
		};
		const gate = () => {
			controller.signal.throwIfAborted();
			if (!heartbeat()) throw new Error("Native task lost its execution lease.");
		};
		let checkpoint: NativeTaskCheckpoint = stored ?? {
			version: 1,
			phase: "prepared",
			attempt: 1,
			isolationId: null,
			baseline: null,
			patchPaths: [],
			branchName: null,
			receipt: null,
			integrationError: null,
		};
		const attempt = stored?.phase === "generated" ? stored.attempt : (stored?.attempt ?? 0) + 1;
		const artifactsDir = path.join(options.artifactsDir, ctx.job.id, `attempt-${attempt}`);
		await fs.mkdir(artifactsDir, { recursive: true });
		const writeCheckpoint = (value: NativeTaskCheckpoint) => {
			gate();
			try {
				ctx.checkpointWrite(nativeTaskJson(value));
				checkpoint = value;
			} catch (error) {
				controller.abort(error);
				throw error;
			}
		};
		const managed: JobExecutorContext = {
			...ctx,
			signal: controller.signal,
			heartbeat,
			checkpointWrite: data => writeCheckpoint(parseNativeTaskCheckpoint(data)),
		};
		const timer = setInterval(heartbeat, interval);
		let releaseLock: (() => Promise<void>) | undefined;
		let session: AgentSession | undefined;
		const toReceipt = async (result: SingleResult): Promise<NativeTaskReceipt> => {
			const output = bounded(result.output || result.error || result.stderr || "Native task produced no output.");
			const outputPath = path.join(artifactsDir, `${payload.agentId}.md`);
			await fs.writeFile(outputPath, output);
			return {
				kind: "native-task",
				agentId: payload.agentId,
				output,
				outputPath,
				exitCode: result.exitCode,
				changesApplied: result.changesApplied === true,
				mergeSummary: bounded(result.mergeSummary ?? "", 2000),
				artifacts: [
					...new Set([
						...checkpoint.patchPaths,
						...(result.transcriptArtifact ? [result.transcriptArtifact] : []),
						outputPath,
					]),
				],
				branchName: result.branchName ?? null,
			};
		};
		const integrate = async (result: SingleResult, generatedReceipt?: CodeWriteReceipt) => {
			const baseline = checkpoint.baseline;
			const code = payload.params.codeWrite
				? type({ reference: "string", target: "string", spec: "string" }).assert(payload.params.codeWrite)
				: undefined;
			if (baseline && result.exitCode === 0 && !result.error && !result.isError && !result.aborted) {
				releaseLock = await acquireNativeTaskIntegrationLock({
					store: options.store,
					artifactsDir: options.artifactsDir,
					repoRoot: baseline.root.repoRoot,
					ctx: managed,
				});
				gate();
				writeCheckpoint({ ...checkpoint, phase: "integrating" });
				controller.signal.throwIfAborted();
				await integrateTaskResult({
					result,
					repoRoot: baseline.root.repoRoot,
					mergeMode: policy.mergeMode,
					signal: controller.signal,
					codeWrite: code
						? {
								kind: "code-write",
								reference: path.resolve(payload.cwd, code.reference),
								target: path.resolve(payload.cwd, code.target),
								workspaceRoot: payload.cwd,
							}
						: undefined,
				});
			}
			gate();
			if (code && result.exitCode === 0 && !result.error && !result.isError) {
				const observed = await observeCodeWrite(
					{
						kind: "code-write",
						reference: path.resolve(payload.cwd, code.reference),
						target: path.resolve(payload.cwd, code.target),
						workspaceRoot: payload.cwd,
					},
					code.target,
				);
				generatedReceipt = { ...observed, changesApplied: result.changesApplied === true };
			}
			if (contract)
				await projectDelegatedIoResult({ result, kind: contract, artifactsDir, receipt: generatedReceipt });
			const receipt = await toReceipt(result);
			if (result.exitCode !== 0 || result.error || result.isError || result.aborted) {
				writeCheckpoint({ ...checkpoint, receipt: nativeTaskJson(receipt), integrationError: receipt.output });
				throw new Error("Native task failed; inspect its retained checkpoint and artifacts.");
			}
			writeCheckpoint({
				...checkpoint,
				phase: "integrated",
				receipt: nativeTaskJson(receipt),
				integrationError: null,
			});
			if (releaseLock) {
				await releaseLock();
				releaseLock = undefined;
			}
		};
		const runtime: NativeTaskRuntime = {
			payload,
			artifactsDir,
			get checkpoint() {
				return checkpoint;
			},
			prepare: baseline =>
				writeCheckpoint({
					...checkpoint,
					phase: "prepared",
					attempt,
					baseline,
					isolationId: null,
					receipt: null,
					branchName: null,
					integrationError: null,
				}),
			executing: isolationId => writeCheckpoint({ ...checkpoint, phase: "executing", isolationId }),
			complete: async (result, baseline, receipt) => {
				gate();
				const retained: string[] = [];
				const nested: Array<{ relativePath: string; patchPath: string; touchedFiles?: string[] }> = [];
				if (result.patchPath) {
					const rootPatch = path.join(artifactsDir, "root.patch");
					await fs.copyFile(result.patchPath, rootPatch);
					result.patchPath = rootPatch;
					retained.push(rootPatch);
				}
				for (const [index, patch] of (result.nestedPatches ?? []).entries()) {
					const patchPath = path.join(artifactsDir, `nested-${index}.patch`);
					await fs.writeFile(patchPath, patch.patch);
					retained.push(patchPath);
					nested.push({ relativePath: patch.relativePath, patchPath, touchedFiles: patch.touchedFiles });
				}
				const raw = path.join(artifactsDir, "worker-result.json");
				await fs.writeFile(raw, JSON.stringify(result));
				retained.push(raw);
				const outputPath = path.join(artifactsDir, "worker-output.txt");
				await fs.writeFile(
					outputPath,
					result.outputPath ? await fs.readFile(result.outputPath, "utf8") : result.output,
				);
				retained.push(outputPath);
				result.outputPath = outputPath;
				writeCheckpoint({
					...checkpoint,
					phase: "generated",
					baseline,
					patchPaths: [...checkpoint.patchPaths, ...retained],
					branchName: result.branchName ?? null,
					receipt: nativeTaskJson({
						generated: true,
						resultPath: raw,
						outputPath,
						nested,
						codeReceipt: receipt ?? null,
					}),
					integrationError: null,
				});
				await integrate(result, receipt);
			},
		};
		executions.set(managed, runtime);
		try {
			gate();
			const artifactRoot = await fs.realpath(options.artifactsDir);
			const jobArtifactRoot = await fs.realpath(path.join(options.artifactsDir, ctx.job.id));
			if (!isPathWithinWorkspace(artifactRoot, jobArtifactRoot))
				throw new Error("Malformed native task artifact root; recovery requires reconciliation.");
			const validateArtifact = async (file: string) => {
				if (!path.isAbsolute(file) || !isPathWithinWorkspace(jobArtifactRoot, await fs.realpath(file)))
					throw new Error("Malformed native task artifact path; recovery requires reconciliation.");
			};
			if (stored?.phase === "generated") {
				const generated = type({
					generated: "true",
					resultPath: "string",
					outputPath: "string",
					nested: type({ relativePath: "string", patchPath: "string", "touchedFiles?": "string[]" }).array(),
					codeReceipt: "unknown",
				}).assert(stored.receipt);
				if (payload.params.codeWrite) {
					const code = type({ target: "string" }).assert(payload.params.codeWrite);
					parseCodeReceipt(generated.codeReceipt, code.target, false);
				}
				if (!stored.patchPaths.includes(generated.resultPath) || !stored.patchPaths.includes(generated.outputPath))
					throw new Error("Malformed native task generated artifact references.");
				for (const file of stored.patchPaths) await validateArtifact(file);
				for (const nested of generated.nested) {
					if (
						!stored.patchPaths.includes(nested.patchPath) ||
						path.isAbsolute(nested.relativePath) ||
						nested.relativePath.split(/[\\/]/).includes("..")
					)
						throw new Error("Malformed native task nested patch path.");
				}
				const value = JSON.parse(await fs.readFile(generated.resultPath, "utf8"));
				const result = type({
					id: "string",
					agent: "string",
					agentSource: "'bundled'|'project'|'user'",
					index: "number",
					task: "string",
					exitCode: "number",
					output: "string",
					stderr: "string",
					truncated: "boolean",
					durationMs: "number",
					tokens: "number",
					requests: "number",
					"error?": "string",
					"isError?": "boolean",
					"aborted?": "boolean",
				}).assert(value);
				if (
					result.id !== payload.agentId ||
					result.agent !== definition.name ||
					result.exitCode !== 0 ||
					result.error ||
					result.isError ||
					result.aborted
				)
					throw new Error("Malformed native task generated worker result.");
				if (
					!stored.baseline &&
					(payload.params.codeWrite ||
						stored.branchName ||
						stored.patchPaths.some(file => file.endsWith(".patch")))
				)
					throw new Error("Native task generated changes require their retained baseline.");
				if (stored.baseline) {
					const root = await fs.realpath(stored.baseline.root.repoRoot);
					const cwd = await fs.realpath(payload.cwd);
					if (path.relative(root, cwd) !== "" && !isPathWithinWorkspace(root, cwd))
						throw new Error("Native task baseline does not contain its workspace.");
				}
				const resumed: SingleResult = {
					...result,
					patchPath: stored.patchPaths.find(file => file.endsWith("root.patch")),
					branchName: stored.branchName ?? undefined,
					outputPath: generated.outputPath,
					nestedPatches: await Promise.all(
						generated.nested.map(async nested => ({
							relativePath: nested.relativePath,
							touchedFiles: nested.touchedFiles,
							patch: await fs.readFile(nested.patchPath, "utf8"),
						})),
					),
				};
				await integrate(resumed);
			} else {
				if (stored) {
					const orphan = path.join(artifactsDir, "orphan-attempt.json");
					await fs.writeFile(orphan, JSON.stringify(stored));
					checkpoint = { ...checkpoint, patchPaths: [...checkpoint.patchPaths, orphan] };
				}
				// Reconstruct the stored execution policy, not unrelated mutable host Fusion routes.
				// SDK auth/model registry discovery still uses normal configured credentials.
				const settings = Settings.isolated();
				settings.override("fusion.enabled", true);
				settings.override("fusion.mode", "autonomous");
				settings.override("async.enabled", false);
				settings.override("task.batch", false);
				settings.override(
					"task.isolation.mode",
					policy.isolationMode === "worktree"
						? "rcopy"
						: policy.isolationMode === "fuse-overlay"
							? "overlayfs"
							: policy.isolationMode === "fuse-projfs"
								? "projfs"
								: policy.isolationMode,
				);
				settings.override("task.isolation.merge", policy.mergeMode);
				settings.override("task.maxRecursionDepth", policy.maxRecursionDepth);
				settings.override("task.maxRuntimeMs", policy.maxRuntimeMs);
				const created = await (options.createSession ?? createAgentSession)({
					cwd: payload.cwd,
					settings,
					sessionManager: SessionManager.inMemory(payload.cwd),
					model: undefined,
					taskDepth: payload.taskDepth,
					agentId: `native-exec-${ctx.job.id}-${attempt}`,
					parentTaskPrefix: `native-exec-${ctx.job.id}-${attempt}`,
					nativeTaskExecution: managed,
					toolNames: ["task"],
					outputSchema: policy.outputSchema ?? undefined,
					disableExtensionDiscovery: true,
					enableMCP: false,
					enableIrc: false,
					enableLsp: false,
					skipPythonPreflight: true,
					contextFiles: [],
					skills: [],
					rules: [],
					promptTemplates: [],
					slashCommands: [],
					preloadedCustomToolPaths: [],
					preloadedExtensionPaths: [],
				});
				session = created.session;
				const task = session.getToolByName("task");
				if (!task) throw new Error("Native task dependency unavailable: native task tool.");
				const result = await task.execute(`native-${ctx.job.id}`, payload.params, managed.signal);
				if (checkpoint.phase !== "integrated") {
					const details = result.details as TaskToolDetails | undefined;
					const diagnostic = bounded(
						result.content
							.filter(part => part.type === "text")
							.map(part => part.text)
							.join("\n"),
						2000,
					);
					writeCheckpoint({
						...checkpoint,
						integrationError: diagnostic,
						receipt:
							checkpoint.receipt ?? nativeTaskJson({ error: diagnostic, artifacts: checkpoint.patchPaths }),
					});
					throw new Error(
						details?.results[0]?.error ?? diagnostic ?? "Native task did not produce an integrated checkpoint.",
					);
				}
			}
			gate();
			return nativeTaskJson(parseNativeTaskReceipt(checkpoint.receipt));
		} catch (error) {
			// Failure evidence is fenced too: never overwrite a newer owner's checkpoint.
			if (!controller.signal.aborted && heartbeat()) {
				const diagnostic = bounded(error instanceof Error ? error.message : String(error), 2000);
				writeCheckpoint({
					...checkpoint,
					integrationError: checkpoint.integrationError ?? diagnostic,
					receipt: checkpoint.receipt ?? nativeTaskJson({ error: diagnostic, artifacts: checkpoint.patchPaths }),
				});
			}
			throw error;
		} finally {
			clearInterval(timer);
			ctx.signal.removeEventListener("abort", abort);
			executions.delete(managed);
			await session?.dispose();
			// Uncertain/in-progress integrations intentionally retain their lock for reconciliation.
			if (releaseLock && checkpoint.phase !== "integrating") await releaseLock();
		}
	};
}
