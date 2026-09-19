/**
 * WorkerNeededReplayV1 — smallest private snapshot sufficient to replay
 * an rlm.worker_needed decision counterfactually.
 *
 * Raw prompt + granted evidence stay under ~/.z0int/replay/… only.
 * Tokenomics receives hashes / IDs / provenance — never grant bodies.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WorkerModeAutoDecision, WorkerModePolicyInput } from "../worker-mode-policy";
import type { WorkerNeededFeatureState, WorkerNeededLabel } from "./worker-needed-features";

export const WORKER_NEEDED_REPLAY_SCHEMA = "omp.rlm.worker_needed_replay.v1";
export const WORKER_NEEDED_REPLAY_EXPERIMENT = "rlm-worker-needed-replay-v1";

export type ReplayVerifierKind = "contains_token" | "atom_equals" | "unavailable";

export interface ReplayVerifierSpec {
	kind: ReplayVerifierKind;
	/** Expected token / atom value when kind is contains_token | atom_equals. */
	token?: string;
	atomKey?: string;
	/** Native is non-inferior if within these ratios of the worker arm. */
	nonInferiority: {
		maxLatencyRatio: number;
		maxTokenRatio: number;
		/** Relative savings required to prefer native when both pass. */
		minCostAdvantage: number;
	};
}

export interface WorkerNeededReplayManifest {
	schema: typeof WORKER_NEEDED_REPLAY_SCHEMA;
	snapshot_id: string;
	created_at: number;
	capability_id: "rlm.worker_needed";
	pair_id: string;
	trace_id: string;
	session_id: string;
	handle: string;
	question_sha256: string;
	grants_sha256: string;
	feature_hash: string;
	shadow_prediction?: WorkerNeededLabel;
	actual_policy?: Exclude<WorkerNeededLabel, "abstain">;
	confidence?: number;
}

export interface WorkerNeededReplayProvenance {
	selection_policy: "shadow_disagreement" | "manual" | "test";
	shadow_backend_id?: string;
	omp_context_policy?: string;
	feature_schema: string;
	contract: string;
	patterns: string[];
	grant_ranges?: Array<{ start: number; end: number }>;
	complexity_class?: string;
	auto_gate_mode?: string;
	root_model?: { provider?: string; name?: string; revision?: string };
	worker_config?: { mode: "prose" | "evidence-packet"; codec?: string };
	temperature?: number;
	seed?: number;
}

export interface WorkerNeededReplaySnapshot {
	manifest: WorkerNeededReplayManifest;
	policyInput: WorkerModePolicyInput;
	featureState: WorkerNeededFeatureState;
	/** Private: full granted evidence corpus for restore. */
	grantedEvidence: string;
	rootConfig: {
		reasoningEffort?: string;
		systemPolicyHash?: string;
		toolSchemaHash?: string;
		contextPolicyHash?: string;
	};
	verifier: ReplayVerifierSpec;
	provenance: WorkerNeededReplayProvenance;
	autoDecision?: WorkerModeAutoDecision | null;
}

export function defaultWorkerNeededReplayRoot(): string {
	const z0 = process.env.Z0INT_HOME?.trim() || join(homedir(), ".z0int");
	return join(z0, "replay", "rlm-worker-needed");
}

export function snapshotDir(snapshotId: string, root = defaultWorkerNeededReplayRoot()): string {
	return join(root, snapshotId);
}

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function deriveVerifierFromEvidence(question: string, evidence: string): ReplayVerifierSpec {
	const nonInferiority = {
		maxLatencyRatio: 1.25,
		maxTokenRatio: 1.15,
		minCostAdvantage: 0.05,
	};
	const root = /root_cause=([A-Za-z0-9_]+)/.exec(evidence);
	if (root) {
		return { kind: "contains_token", token: root[1], atomKey: "root_cause", nonInferiority };
	}
	const needle = /(NEEDLE_[A-Za-z0-9_]+)/.exec(evidence);
	if (needle) {
		return { kind: "contains_token", token: needle[1], atomKey: "needle", nonInferiority };
	}
	const q = question.toLowerCase();
	if (q.includes("effective") && /max_connections\s*=\s*(\d+)/i.test(evidence)) {
		// Prefer the more restrictive / last declared effective limit when present.
		const limits = [...evidence.matchAll(/(?:max_connections|pool_limit)\s*=\s*(\d+)/gi)].map(m => Number(m[1]));
		if (limits.length > 0) {
			const token = String(Math.min(...limits));
			return { kind: "contains_token", token, atomKey: "effective_limit", nonInferiority };
		}
	}
	return { kind: "unavailable", nonInferiority };
}

export function buildSnapshotId(parts: {
	pairId: string;
	featureHash: string;
	grantsSha256: string;
}): string {
	return createHash("sha256")
		.update(`${parts.pairId}|${parts.featureHash}|${parts.grantsSha256}`)
		.digest("hex")
		.slice(0, 24);
}

export async function freezeWorkerNeededReplaySnapshot(
	input: {
		pairId: string;
		traceId: string;
		sessionId: string;
		handle: string;
		policyInput: WorkerModePolicyInput;
		featureState: WorkerNeededFeatureState;
		featureHash: string;
		grantedEvidence: string;
		shadowPrediction?: WorkerNeededLabel;
		actualPolicy?: Exclude<WorkerNeededLabel, "abstain">;
		confidence?: number;
		autoDecision?: WorkerModeAutoDecision | null;
		provenance?: Partial<WorkerNeededReplayProvenance>;
		rootConfig?: WorkerNeededReplaySnapshot["rootConfig"];
		verifier?: ReplayVerifierSpec;
	},
	root = defaultWorkerNeededReplayRoot(),
): Promise<WorkerNeededReplaySnapshot> {
	const grantsSha256 = sha256Hex(input.grantedEvidence);
	const snapshotId = buildSnapshotId({
		pairId: input.pairId,
		featureHash: input.featureHash,
		grantsSha256,
	});
	const verifier =
		input.verifier ?? deriveVerifierFromEvidence(input.policyInput.question, input.grantedEvidence);
	const snapshot: WorkerNeededReplaySnapshot = {
		manifest: {
			schema: WORKER_NEEDED_REPLAY_SCHEMA,
			snapshot_id: snapshotId,
			created_at: Date.now(),
			capability_id: "rlm.worker_needed",
			pair_id: input.pairId,
			trace_id: input.traceId,
			session_id: input.sessionId,
			handle: input.handle,
			question_sha256: input.featureState.question_sha256,
			grants_sha256: grantsSha256,
			feature_hash: input.featureHash,
			shadow_prediction: input.shadowPrediction,
			actual_policy: input.actualPolicy,
			confidence: input.confidence,
		},
		policyInput: {
			...input.policyInput,
			// Keep question in private snapshot only; Tokenomics never sees this file.
			question: input.policyInput.question,
			grantTextSample: input.policyInput.grantTextSample?.slice(0, 4096),
		},
		featureState: input.featureState,
		grantedEvidence: input.grantedEvidence,
		rootConfig: input.rootConfig ?? {},
		verifier,
		provenance: {
			selection_policy: input.provenance?.selection_policy ?? "shadow_disagreement",
			shadow_backend_id: input.provenance?.shadow_backend_id,
			omp_context_policy: input.provenance?.omp_context_policy,
			feature_schema: input.provenance?.feature_schema ?? "omp.shadow.rlm.worker_needed.features.v1",
			contract: input.provenance?.contract ?? "decision-capability-v1",
			patterns: [...(input.policyInput.patterns ?? [])],
			grant_ranges: input.provenance?.grant_ranges,
			complexity_class: input.featureState.complexity_class,
			auto_gate_mode: input.autoDecision?.mode,
			root_model: input.provenance?.root_model,
			worker_config: input.provenance?.worker_config ?? {
				mode: input.actualPolicy === "worker" ? "evidence-packet" : "prose",
			},
			temperature: input.provenance?.temperature,
			seed: input.provenance?.seed,
		},
		autoDecision: input.autoDecision ?? null,
	};

	const dir = snapshotDir(snapshotId, root);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "manifest.json"), `${JSON.stringify(snapshot.manifest, null, 2)}\n`, "utf8");
	await writeFile(
		join(dir, "policy-input.json"),
		`${JSON.stringify(
			{
				policyInput: snapshot.policyInput,
				featureState: snapshot.featureState,
				autoDecision: snapshot.autoDecision,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	await writeFile(join(dir, "granted-evidence.bin"), snapshot.grantedEvidence, "utf8");
	await writeFile(join(dir, "root-config.json"), `${JSON.stringify(snapshot.rootConfig, null, 2)}\n`, "utf8");
	await writeFile(join(dir, "verifier.json"), `${JSON.stringify(snapshot.verifier, null, 2)}\n`, "utf8");
	await writeFile(join(dir, "provenance.json"), `${JSON.stringify(snapshot.provenance, null, 2)}\n`, "utf8");
	return snapshot;
}

export async function loadWorkerNeededReplaySnapshot(
	snapshotId: string,
	root = defaultWorkerNeededReplayRoot(),
): Promise<WorkerNeededReplaySnapshot> {
	const dir = snapshotDir(snapshotId, root);
	const [manifest, policyBundle, grantedEvidence, rootConfig, verifier, provenance] = await Promise.all([
		readFile(join(dir, "manifest.json"), "utf8").then(t => JSON.parse(t) as WorkerNeededReplayManifest),
		readFile(join(dir, "policy-input.json"), "utf8").then(
			t =>
				JSON.parse(t) as {
					policyInput: WorkerModePolicyInput;
					featureState: WorkerNeededFeatureState;
					autoDecision?: WorkerModeAutoDecision | null;
				},
		),
		readFile(join(dir, "granted-evidence.bin"), "utf8"),
		readFile(join(dir, "root-config.json"), "utf8").then(
			t => JSON.parse(t) as WorkerNeededReplaySnapshot["rootConfig"],
		),
		readFile(join(dir, "verifier.json"), "utf8").then(t => JSON.parse(t) as ReplayVerifierSpec),
		readFile(join(dir, "provenance.json"), "utf8").then(t => JSON.parse(t) as WorkerNeededReplayProvenance),
	]);
	if (sha256Hex(grantedEvidence) !== manifest.grants_sha256) {
		throw new Error(`granted evidence hash mismatch for snapshot ${snapshotId}`);
	}
	return {
		manifest,
		policyInput: policyBundle.policyInput,
		featureState: policyBundle.featureState,
		grantedEvidence,
		rootConfig,
		verifier,
		provenance,
		autoDecision: policyBundle.autoDecision ?? null,
	};
}
