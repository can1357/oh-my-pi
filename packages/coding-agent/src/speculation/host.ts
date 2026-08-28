import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	AgentToolResult,
	SpeculativeAuthorization,
	SpeculativeCommitContext,
	SpeculativeCommitDecision,
	SpeculativeDiscardContext,
	SpeculativeExecutionHost,
	SpeculativeOperationContext,
} from "@oh-my-pi/pi-agent-core";
import type { Settings } from "../config/settings";
import { SNAPSHOT_MAX_BYTES } from "../edit/file-snapshot-store";
import { normalizeToLF } from "../edit/normalize";
import type { ToolSession } from "../tools";
import { type ApprovalMode, resolveApproval } from "../tools/approval";
import type { LocalReadSpeculationEvidence } from "../tools/read";

type LocalReadEvidence = {
	path: string;
	device: number;
	inode: number;
	mtimeMs: number;
	size: number;
	digest: string;
	snapshotDigest: string;
};

function isLocalReadSpeculationEvidence(value: unknown): value is LocalReadSpeculationEvidence {
	return (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		value.kind === "local_read" &&
		"resource" in value &&
		typeof value.resource === "string" &&
		"snapshotDigest" in value &&
		typeof value.snapshotDigest === "string"
	);
}

export interface SpeculationLifecycle {
	hasHandlers(eventType: string): boolean;
}

export type CodingAgentSpeculativeOperation = "direct.read" | "eval.read";

/** Maps the two supported local-read paths to stable operation identifiers. */
function operationGrant(context: SpeculativeOperationContext): CodingAgentSpeculativeOperation | undefined {
	if (context.tool.name !== "read" || context.effect.kind !== "local_read") return undefined;
	return context.source === "direct" ? "direct.read" : "eval.read";
}

function hasLifecycleHandlers(runner: SpeculationLifecycle): boolean {
	return (
		runner.hasHandlers("tool_call") ||
		runner.hasHandlers("tool_result") ||
		runner.hasHandlers("tool_approval_requested") ||
		runner.hasHandlers("tool_approval_resolved")
	);
}
function sameResourceState(left: nodeFs.Stats, right: nodeFs.Stats): boolean {
	return (
		left.dev === right.dev && left.ino === right.ino && left.mtimeMs === right.mtimeMs && left.size === right.size
	);
}

async function captureEvidence(target: string): Promise<LocalReadEvidence | undefined> {
	try {
		const state = await fs.lstat(target);
		if (state.isSymbolicLink() || !state.isFile() || state.size > SNAPSHOT_MAX_BYTES) return undefined;
		const bytes = await fs.readFile(target);
		if (!sameResourceState(state, await fs.lstat(target))) return undefined;
		const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
		const rawText = bytes.toString("utf8");
		const strippedText = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;
		const normalizedText = strippedText.includes("\r") ? normalizeToLF(strippedText) : strippedText;
		const snapshotDigest = new Bun.CryptoHasher("sha256").update(normalizedText).digest("hex");
		return {
			path: target,
			device: state.dev,
			inode: state.ino,
			mtimeMs: state.mtimeMs,
			size: state.size,
			digest,
			snapshotDigest,
		};
	} catch {
		return undefined;
	}
}

/**
 * Session-scoped policy boundary for validated local reads.
 *
 * Ordinary approval and extension lifecycle hooks remain authoritative. Every
 * other effect, including writes, completions, and remote GETs, fails closed.
 */
export class CodingAgentSpeculativeExecutionHost implements SpeculativeExecutionHost {
	#evidence = new Map<string, LocalReadEvidence>();

	constructor(
		private readonly settings: Settings,
		private readonly toolSession: ToolSession,
		private readonly extensionRunner: SpeculationLifecycle,
	) {}

	async authorize(context: SpeculativeOperationContext): Promise<SpeculativeAuthorization> {
		if (!this.settings.get("tools.speculativeExecution.enabled")) {
			return { allowed: false, reason: "speculative execution is disabled" };
		}
		const operation = operationGrant(context);
		if (!operation) {
			return { allowed: false, reason: "tool and effect pair is not supported for speculative execution" };
		}
		if (context.effect.kind !== "local_read") {
			return { allowed: false, reason: "tool and effect pair is not supported for speculative execution" };
		}
		if (hasLifecycleHandlers(this.extensionRunner)) {
			return { allowed: false, reason: "active extension lifecycle handler" };
		}
		const approvalMode = this.settings.get("tools.approvalMode") as ApprovalMode;
		const policies = this.settings.get("tools.approval") as Record<string, unknown>;
		const approval = resolveApproval(context.tool, context.args, approvalMode, policies);
		if (approval.policy !== "allow") return { allowed: false, reason: "tool approval is not auto-allow" };
		const resource = context.effect.resources[0];
		if (!resource || context.effect.resources.length !== 1 || resource.access !== "read") {
			return { allowed: false, reason: "local read must have one read resource" };
		}
		if (typeof context.args.path !== "string") return { allowed: false, reason: "local read path is invalid" };
		let resolved: string;
		try {
			resolved = await fs.realpath(path.resolve(this.toolSession.cwd, context.args.path));
		} catch {
			return { allowed: false, reason: "local read path is unavailable" };
		}
		if (resolved !== resource.path) return { allowed: false, reason: "local read resource changed" };
		const evidence = await captureEvidence(resolved);
		if (!evidence) return { allowed: false, reason: "local read target is unsafe" };
		this.#evidence.set(context.candidateId, evidence);
		return { allowed: true, deferBeforeToolCall: true };
	}

	async validate(context: SpeculativeCommitContext): Promise<boolean> {
		const expected = this.#evidence.get(context.candidateId);
		if (!expected) return false;
		const consumed = context.physicalOutcome.evidence;
		if (
			!isLocalReadSpeculationEvidence(consumed) ||
			consumed.resource !== expected.path ||
			consumed.snapshotDigest !== expected.snapshotDigest
		) {
			return false;
		}
		const authorization = await this.authorize(context);
		if (!authorization.allowed) return false;
		const current = this.#evidence.get(context.candidateId);
		return (
			current !== undefined &&
			current.device === expected.device &&
			current.inode === expected.inode &&
			current.mtimeMs === expected.mtimeMs &&
			current.size === expected.size &&
			current.digest === expected.digest &&
			current.snapshotDigest === expected.snapshotDigest
		);
	}

	async commit(
		context: SpeculativeCommitContext,
		commitDefault: () => Promise<AgentToolResult<unknown>>,
	): Promise<SpeculativeCommitDecision> {
		try {
			return { kind: "committed" as const, result: await commitDefault() };
		} catch (error) {
			return { kind: "failed" as const, error };
		} finally {
			this.#evidence.delete(context.candidateId);
		}
	}

	discard(context: SpeculativeDiscardContext): void {
		this.#evidence.delete(context.candidateId);
	}

	close(): void {
		this.#evidence.clear();
	}
}
