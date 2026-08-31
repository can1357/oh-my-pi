import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type Tool as AiTool, validateToolArguments } from "@oh-my-pi/pi-ai";
import { Settings } from "../config/settings";
import { EditTool } from "../edit";
import { LspTool } from "../lsp/tool";
import type { ToolSession } from "../tools";
import { AstEditTool } from "../tools/ast-edit";
import { WriteTool } from "../tools/write";
import { stableJson } from "./canonical-json";
import { ASSIGNMENT_TOOL_WORKER_SCHEMA } from "./tool-worker-protocol";

const ASSIGNMENT_CAPABILITY_SCHEMA = "juiz.assignment-capability/1" as const;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;
type WorkerToolName = "write" | "edit" | "ast_edit" | "lsp";

function object(value: unknown): JsonRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("INVALID_REQUEST");
	return value as JsonRecord;
}

function closed(value: unknown, fields: readonly string[]): JsonRecord {
	const result = object(value);
	const keys = Object.keys(result);
	if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) throw new Error("INVALID_REQUEST");
	return result;
}

function stringField(record: JsonRecord, field: string): string {
	const value = record[field];
	if (typeof value !== "string" || value.length === 0) throw new Error("INVALID_REQUEST");
	return value;
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Buffer.from(digest).toString("hex");
}

async function effectiveArgsDigest(value: unknown): Promise<string> {
	return `sha256:${await sha256Hex(stableJson(value))}`;
}

function remapPath(value: string, logicalPrefix: string, projectionPrefix: string): string {
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) throw new Error("PATH_NOT_FILESYSTEM");
	const logical = path.normalize(logicalPrefix);
	const absolute = path.isAbsolute(value) ? path.normalize(value) : path.resolve(logical, value);
	if (absolute !== logical && !absolute.startsWith(`${logical}${path.sep}`))
		throw new Error("PATH_OUTSIDE_ASSIGNMENT");
	return path.normalize(projectionPrefix) + absolute.slice(logical.length);
}

function remapEditInput(input: string, logicalPrefix: string, projectionPrefix: string): string {
	return input
		.split("\n")
		.map(line => {
			const hashline = /^(\[)([^\]#]+)(#[0-9A-Fa-f]+\])$/.exec(line);
			if (hashline) return `${hashline[1]}${remapPath(hashline[2], logicalPrefix, projectionPrefix)}${hashline[3]}`;
			const sloppy = /^(\[)([^\]\n]+)(\])$/.exec(line);
			if (sloppy) return `${sloppy[1]}${remapPath(sloppy[2], logicalPrefix, projectionPrefix)}${sloppy[3]}`;
			const marker = /^(\*\*\* (?:Add|Delete|Update) File: )(.+)$/.exec(line);
			if (marker) return marker[1] + remapPath(marker[2], logicalPrefix, projectionPrefix);
			const move = /^(\*\*\* Move to: |MV )(.+)$/.exec(line);
			if (move) return move[1] + remapPath(move[2], logicalPrefix, projectionPrefix);
			return line;
		})
		.join("\n");
}

function remapArgs(tool: WorkerToolName, value: unknown, logicalPrefix: string, projectionPrefix: string): JsonRecord {
	const args = object(value);
	const output: JsonRecord = { ...args };
	if (tool === "write") {
		if (typeof args.path !== "string") throw new Error("INVALID_TOOL_ARGS");
		output.path = remapPath(args.path, logicalPrefix, projectionPrefix);
		return output;
	}
	if (tool === "ast_edit") {
		if (!Array.isArray(args.paths) || !args.paths.every(entry => typeof entry === "string")) {
			throw new Error("INVALID_TOOL_ARGS");
		}
		output.paths = args.paths.map(entry => remapPath(entry as string, logicalPrefix, projectionPrefix));
		return output;
	}
	if (tool === "lsp") {
		const action = typeof args.action === "string" ? args.action : "";
		if (action !== "rename" && action !== "rename_file" && !(action === "code_actions" && args.apply === true)) {
			throw new Error("INVALID_TOOL_ACTION");
		}
		if (typeof args.file !== "string") throw new Error("INVALID_TOOL_ARGS");
		output.file = remapPath(args.file, logicalPrefix, projectionPrefix);
		if (action === "rename_file") {
			if (typeof args.new_name !== "string") throw new Error("INVALID_TOOL_ARGS");
			output.new_name = remapPath(args.new_name, logicalPrefix, projectionPrefix);
		}
		return output;
	}

	if (typeof args.path === "string") output.path = remapPath(args.path, logicalPrefix, projectionPrefix);
	if (Array.isArray(args.edits)) {
		output.edits = args.edits.map(value => {
			const edit = object(value);
			return typeof edit.rename === "string"
				? { ...edit, rename: remapPath(edit.rename, logicalPrefix, projectionPrefix) }
				: { ...edit };
		});
	}
	if (typeof args.input === "string") output.input = remapEditInput(args.input, logicalPrefix, projectionPrefix);
	if (typeof output.path !== "string" && typeof output.input !== "string") throw new Error("INVALID_TOOL_ARGS");
	return output;
}

function editMode(args: JsonRecord): "replace" | "patch" | "hashline" | "apply_patch" | "sloppy" {
	if (typeof args.path === "string" && typeof args.old_string === "string") return "replace";
	if (typeof args.path === "string" && Array.isArray(args.edits)) return "patch";
	if (typeof args.input !== "string") throw new Error("INVALID_TOOL_ARGS");
	if (/^\*\*\* Begin Patch\n\*\*\* (?:Add|Delete|Update) File:/m.test(args.input)) return "apply_patch";
	if (/^\[[^\]\n]+#[0-9A-Fa-f]+\]$/m.test(args.input)) return "hashline";
	return "sloppy";
}

function hideProjection<T>(value: T, logicalPrefix: string, projectionPrefix: string): T {
	const visit = (entry: unknown): unknown => {
		if (typeof entry === "string") return entry.split(projectionPrefix).join(logicalPrefix);
		if (Array.isArray(entry)) return entry.map(visit);
		if (typeof entry !== "object" || entry === null) return entry;
		return Object.fromEntries(Object.entries(entry).map(([key, nested]) => [key, visit(nested)]));
	};
	return visit(value) as T;
}

function createWorkerTool(tool: WorkerToolName, args: JsonRecord, session: ToolSession) {
	switch (tool) {
		case "write":
			return new WriteTool(session);
		case "edit":
			return new EditTool(session, editMode(args));
		case "ast_edit":
			return new AstEditTool(session);
		case "lsp":
			return new LspTool(session);
	}
}

function launchPreimage(attempt: JsonRecord): JsonRecord {
	return {
		schema: attempt.schema,
		requestId: attempt.requestId,
		attempt: attempt.attempt,
		thread: attempt.thread,
		participant: attempt.participant,
		session: attempt.session,
		leaseGeneration: attempt.leaseGeneration,
		delivery: attempt.delivery,
		capability: attempt.capability,
		capabilityGeneration: attempt.capabilityGeneration,
		resource: attempt.resource,
		assignment: attempt.assignment,
		preparationDigest: attempt.preparationDigest,
		toolCall: attempt.toolCall,
		tool: attempt.tool,
		effectiveArgsDigest: attempt.effectiveArgsDigest,
		operationDigest: attempt.operationDigest,
		tier: attempt.tier,
		operationCredentialDigest: attempt.operationCredentialDigest,
		writerFencePolicyDigest: attempt.writerFencePolicyDigest,
		deadline: attempt.deadline,
	};
}

export async function runAssignmentToolWorker(): Promise<void> {
	let requestId = "unavailable";
	try {
		const source = await Bun.stdin.text();
		if (Buffer.byteLength(source) > MAX_REQUEST_BYTES) throw new Error("REQUEST_TOO_LARGE");
		const request = closed(JSON.parse(source), [
			"schema",
			"requestId",
			"attempt",
			"operationCredential",
			"tool",
			"effectiveArgs",
			"logicalPathMapping",
			"projection",
		]);
		requestId = stringField(request, "requestId");
		if (request.schema !== ASSIGNMENT_TOOL_WORKER_SCHEMA) throw new Error("INVALID_SCHEMA");
		const attempt = closed(request.attempt, [
			"schema",
			"requestId",
			"attempt",
			"thread",
			"participant",
			"session",
			"leaseGeneration",
			"delivery",
			"capability",
			"capabilityGeneration",
			"resource",
			"assignment",
			"preparationDigest",
			"toolCall",
			"tool",
			"effectiveArgsDigest",
			"operationDigest",
			"tier",
			"operationCredentialDigest",
			"writerFencePolicyDigest",
			"deadline",
			"launchDigest",
			"fenceGeneration",
		]);
		if (attempt.schema !== ASSIGNMENT_CAPABILITY_SCHEMA || attempt.requestId !== requestId) {
			throw new Error("INVALID_ATTEMPT");
		}
		const deadlineText = stringField(attempt, "deadline");
		const deadline = Date.parse(deadlineText);
		if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error("ATTEMPT_EXPIRED");
		const credential = stringField(request, "operationCredential");
		if (`sha256:${await sha256Hex(credential)}` !== stringField(attempt, "operationCredentialDigest")) {
			throw new Error("INVALID_OPERATION_CREDENTIAL");
		}
		if (
			`sha256:${await sha256Hex(JSON.stringify(launchPreimage(attempt)))}` !== stringField(attempt, "launchDigest")
		) {
			throw new Error("INVALID_LAUNCH_DIGEST");
		}
		const tool = stringField(request, "tool");
		if (tool !== "write" && tool !== "edit" && tool !== "ast_edit" && tool !== "lsp") {
			throw new Error("INVALID_TOOL");
		}
		if (attempt.tool !== tool || attempt.tier !== "write") throw new Error("INVALID_ATTEMPT_TOOL");
		if ((await effectiveArgsDigest(request.effectiveArgs)) !== attempt.effectiveArgsDigest) {
			throw new Error("INVALID_EFFECTIVE_ARGS");
		}
		const mapping = closed(request.logicalPathMapping, ["logicalPrefix", "projectionPrefix"]);
		const logicalPrefix = stringField(mapping, "logicalPrefix");
		const projectionPrefix = stringField(mapping, "projectionPrefix");
		const projection = stringField(request, "projection");
		if (
			!path.isAbsolute(logicalPrefix) ||
			!path.isAbsolute(projectionPrefix) ||
			path.normalize(projection) !== path.normalize(projectionPrefix)
		) {
			throw new Error("INVALID_PATH_MAPPING");
		}
		const mappedArgs = remapArgs(tool, request.effectiveArgs, logicalPrefix, projectionPrefix);
		const settings = Settings.isolated({
			"lsp.diagnosticsOnEdit": false,
			"lsp.diagnosticsOnWrite": false,
			"lsp.formatOnWrite": false,
		});
		const session: ToolSession = {
			cwd: projectionPrefix,
			hasUI: false,
			canPromptUser: false,
			enableIrc: false,
			enableMCP: false,
			enableLsp: true,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
		};
		const executable = createWorkerTool(tool, mappedArgs, session);
		const validated = validateToolArguments(executable as unknown as AiTool, {
			type: "toolCall",
			id: requestId,
			name: tool,
			arguments: mappedArgs,
		});
		const result = (await executable.execute(
			requestId,
			validated as never,
			AbortSignal.timeout(deadline - Date.now()),
		)) as AgentToolResult;
		const sanitized = hideProjection(result, logicalPrefix, projectionPrefix);
		process.stdout.write(
			JSON.stringify({ schema: ASSIGNMENT_TOOL_WORKER_SCHEMA, requestId, ok: true, result: sanitized }),
		);
	} catch (error) {
		const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "WORKER_FAILED";
		process.stdout.write(
			JSON.stringify({
				schema: ASSIGNMENT_TOOL_WORKER_SCHEMA,
				requestId,
				ok: false,
				error: { code, message: "Assignment tool worker denied the request" },
			}),
		);
		process.exitCode = 1;
	}
}
