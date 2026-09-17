import path from "node:path";
import { THINKING_EFFORTS } from "@pk-nerdsaver-ai/pi-ai";
import { type } from "arktype";
import type { AgentDefinition } from "../task/types";
import type { WorktreeBaseline } from "../task/worktree";
import type { JsonObject, JsonValue } from "./types";

const strings = type("string[]");
const nonnegative = type("number.integer >= 0");
const profileSchema = type({
	tier: "'light'|'mid'|'frontier'",
	autonomy: "'bound'|'supervised'|'independent'",
	collaboration: "'report-only'|'message-peers'|'self-coordinate'",
	workClass: "'mechanical'|'judgment'",
	editMode: "'none'|'replace'|'hashline'|'apply-patch'",
	maxRequests: nonnegative,
	maxRuntimeMs: nonnegative,
	modelPool: strings,
	modelPoolConstrained: "boolean",
});
const toolsSchema = type({
	maximum: type({ source: "'builtin'|'mcp'|'extension'|'custom'|'hidden'", name: "string > 0" }).array(),
	editMode: "'none'|'replace'|'hashline'|'apply-patch'",
	allowDiscovery: "boolean",
	tier: "'light'|'mid'|'frontier'",
	autonomy: "'bound'|'supervised'|'independent'",
	toolsConstrained: "boolean",
});
const collaborationSchema = type({
	mode: "'report-only'|'message-peers'|'self-coordinate'",
	peerScope: "'parent'|'family'|'allowed'|'all'",
	allowedPeers: strings,
	wakePolicy: "'deny'|'queue'|'allow'",
	wakeBudget: nonnegative,
	allowBusyModelReply: "boolean",
	"parentId?": "string",
	familyIds: strings,
});
const definitionSchema = type({
	name: "string > 0",
	description: "string",
	systemPrompt: "string",
	source: "'bundled'|'user'|'project'",
	"tools?": strings,
	"spawns?": "string[]|'*'",
	"model?": strings,
	"thinkingLevel?": "'off'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'|'ultra'",
	"blocking?": "boolean",
	"autoloadSkills?": strings,
	"readSummarize?": "boolean",
	"prefetch?": "'repo-evidence'",
	"filePath?": "string",
	"output?": "unknown",
});
const baselineRepoSchema = type({
	repoRoot: "string",
	headCommit: "string",
	staged: "string",
	unstaged: "string",
	untracked: strings,
	untrackedPatch: "string",
});
const baselineSchema = type({
	root: baselineRepoSchema,
	nested: type({ relativePath: "string", baseline: baselineRepoSchema }).array(),
});

export interface NativeTaskJobPayload {
	version: 1;
	cwd: string;
	agentId: string;
	parentSessionId: string | null;
	taskDepth: number;
	params: JsonObject;
	effectiveModel: string;
	agentDefinition: JsonObject;
	policy: JsonObject;
}

/** Strict JSON boundary: never silently discard callbacks, cyclic state or missing dependencies. */
export function nativeTaskJson(value: unknown): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (Array.isArray(value)) return value.map(nativeTaskJson);
	if (
		value &&
		typeof value === "object" &&
		(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
	) {
		const result: JsonObject = {};
		for (const [key, child] of Object.entries(value)) if (child !== undefined) result[key] = nativeTaskJson(child);
		return result;
	}
	throw new Error("Native task dependency is not JSON-serializable.");
}

export function nativeTaskObject(value: unknown, label: string): JsonObject {
	const parsed = nativeTaskJson(value);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error(`Malformed native task ${label}: expected an object.`);
	return parsed;
}

export function parseNativeTaskPolicy(value: JsonObject) {
	const fields = [
		"isolationMode",
		"mergeMode",
		"maxRecursionDepth",
		"maxRuntimeMs",
		"outputSchema",
		"executionProfile",
		"toolProfile",
		"collaborationPolicy",
	];
	if (Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key)))
		throw new Error("Malformed native task policy fields.");
	return {
		isolationMode: type(
			"'none'|'auto'|'apfs'|'btrfs'|'zfs'|'reflink'|'overlayfs'|'projfs'|'block-clone'|'rcopy'|'worktree'|'fuse-overlay'|'fuse-projfs'",
		).assert(value.isolationMode),
		mergeMode: type("'patch'|'branch'").assert(value.mergeMode),
		maxRecursionDepth: nonnegative.assert(value.maxRecursionDepth),
		maxRuntimeMs: nonnegative.assert(value.maxRuntimeMs),
		outputSchema: value.outputSchema,
		executionProfile: value.executionProfile === null ? undefined : profileSchema.assert(value.executionProfile),
		toolProfile: value.toolProfile === null ? undefined : toolsSchema.assert(value.toolProfile),
		collaborationPolicy:
			value.collaborationPolicy === null ? undefined : collaborationSchema.assert(value.collaborationPolicy),
	};
}

export function parseNativeTaskDefinition(value: JsonObject): AgentDefinition {
	const parsed = definitionSchema.assert(value);
	return { ...parsed, thinkingLevel: THINKING_EFFORTS.find(effort => effort === parsed.thinkingLevel) };
}

export function parseNativeTaskJobPayload(value: JsonValue): NativeTaskJobPayload {
	const object = nativeTaskObject(value, "payload");
	if (object.version !== 1)
		throw new Error("Unsupported native_task payload version; legacy incomplete rows require reconciliation.");
	const required = [
		"version",
		"cwd",
		"agentId",
		"parentSessionId",
		"taskDepth",
		"params",
		"effectiveModel",
		"agentDefinition",
		"policy",
	];
	if (Object.keys(object).length !== required.length || required.some(key => !Object.hasOwn(object, key)))
		throw new Error("Malformed native_task payload fields; legacy incomplete rows require reconciliation.");
	const cwd = type("string > 0").assert(object.cwd);
	if (!path.isAbsolute(cwd)) throw new Error("Native task cwd must be absolute.");
	const agentId = type("string > 0").assert(object.agentId);
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(agentId)) throw new Error("Malformed native task child identity.");
	const effectiveModel = type("string > 0").assert(object.effectiveModel);
	if (!effectiveModel.includes("/") || effectiveModel.startsWith("pi/"))
		throw new Error("Native task effectiveModel must be a pinned provider/model, not a role alias.");
	const params = nativeTaskObject(object.params, "params");
	if (Object.hasOwn(params, "tasks"))
		throw new Error("Native task payload must contain one validated spawn, not tasks[].");
	if (params.cwd !== undefined && params.cwd !== ".")
		throw new Error("Native task params cwd must be normalized to its payload workspace.");
	type({
		agent: "string > 0",
		assignment: "string > 0",
		"context?": "string",
		"cwd?": "string",
		"isolated?": "boolean",
		"fork?": "boolean",
	}).assert(params);
	if (params.fork === true)
		throw new Error("Native task dependency unavailable: forked parent context cannot be reconstructed.");
	if (params.evidenceDigest) type({ paths: "string[] > 0", question: "string > 0" }).assert(params.evidenceDigest);
	if (params.codeWrite)
		type({ spec: "string > 0", reference: "string > 0", target: "string > 0" }).assert(params.codeWrite);
	if (params.codeWrite && params.evidenceDigest)
		throw new Error("Native task cannot combine codeWrite and evidenceDigest.");
	const agentDefinition = nativeTaskObject(object.agentDefinition, "agentDefinition");
	const definition = parseNativeTaskDefinition(agentDefinition);
	if (definition.name !== params.agent) throw new Error("Native task agent definition does not match its request.");
	const policy = nativeTaskObject(object.policy, "policy");
	parseNativeTaskPolicy(policy);
	return {
		version: 1,
		cwd,
		agentId,
		parentSessionId: type("string|null").assert(object.parentSessionId),
		taskDepth: nonnegative.assert(object.taskDepth),
		params,
		effectiveModel,
		agentDefinition,
		policy,
	};
}

export interface NativeTaskCheckpoint {
	version: 1;
	phase: "prepared" | "executing" | "generated" | "integrating" | "integrated";
	attempt: number;
	isolationId: string | null;
	baseline: WorktreeBaseline | null;
	patchPaths: string[];
	branchName: string | null;
	receipt: JsonValue | null;
	integrationError: string | null;
}

export function parseNativeTaskCheckpoint(value: JsonValue): NativeTaskCheckpoint {
	const object = nativeTaskObject(value, "checkpoint");
	const parsed = type({
		version: "1",
		phase: "'prepared'|'executing'|'generated'|'integrating'|'integrated'",
		attempt: "number.integer > 0",
		isolationId: "string|null",
		patchPaths: strings,
		branchName: "string|null",
		receipt: "unknown",
		integrationError: "string|null",
	}).assert(object);
	const baseline = object.baseline === null ? null : baselineSchema.assert(object.baseline);
	return { ...parsed, baseline, receipt: nativeTaskJson(parsed.receipt) };
}
