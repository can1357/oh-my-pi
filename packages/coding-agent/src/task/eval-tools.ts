import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { EvalKernelNotRunningError } from "../eval/executor-base";
import { invokeJsTool } from "../eval/js/context-manager";
import { resolveJsKernelIdentity } from "../eval/js";
import { callPythonTool, describePythonTools } from "../eval/py/executor";
import { resolvePythonKernelIdentity } from "../eval/py";
import type { EvalToolDescriptor, EvalToolInvokeResult } from "../eval/types";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { ToolSession } from "../tools";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { schemaDeclaresIntentField } from "../utils/tool-schema";

import { cfgEvalToolsEnabled } from "../eval/settings";
import { BUILTIN_TOOL_NAMES, normalizeToolName } from "../tools/builtin-names";
import type { AgentDefinition } from "./types";
import { cfgTaskMaxRecursionDepth } from "./settings";
import { resolveSubagentToolNames } from "./tool-plan";

interface EvalToolQueryResult {
	tools: EvalToolDescriptor[];
	missing: string[];
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function queryPythonTools(
	session: ToolSession,
	names: string[],
	signal?: AbortSignal,
): Promise<EvalToolQueryResult> {
	try {
		return await describePythonTools(names, {
			...resolvePythonKernelIdentity(session),
			toolSession: session,
			signal,
		});
	} catch (error) {
		if (error instanceof EvalKernelNotRunningError) return { tools: [], missing: names };
		throw error;
	}
}

async function queryJsTools(session: ToolSession, names: string[], signal?: AbortSignal): Promise<EvalToolQueryResult> {
	try {
		const result = await invokeJsTool(
			{ op: "describe", names },
			{ ...resolveJsKernelIdentity(session), session, signal },
		);
		if (!result.ok) throw new ToolError(result.error);
		if (!("tools" in result)) throw new ToolError("JavaScript tool describe request returned an invalid response");
		return { tools: result.tools, missing: result.missing };
	} catch (error) {
		if (error instanceof EvalKernelNotRunningError) return { tools: [], missing: names };
		throw error;
	}
}

async function queryAllEvalTools(
	session: ToolSession,
	names: string[],
	signal?: AbortSignal,
): Promise<EvalToolDescriptor[]> {
	const [python, js] = await Promise.all([
		queryPythonTools(session, names, signal),
		queryJsTools(session, names, signal),
	]);
	const byName = new Map<string, EvalToolDescriptor>();
	for (const descriptor of [...python.tools, ...js.tools]) {
		const existing = byName.get(descriptor.name);
		if (existing && existing.language !== descriptor.language) {
			throw new ToolError(
				`eval tool "${descriptor.name}" is defined in both the Python and JS kernels; undefine one`,
			);
		}
		byName.set(descriptor.name, descriptor);
	}
	return [...byName.values()];
}

/** Whether this session may expose kernel-defined tools to subagents (`eval.tools.enabled`). */
export function evalToolsEnabled(session: ToolSession): boolean {
	return cfgEvalToolsEnabled.get(session.settings) !== false;
}

/** Resolve named kernel-defined tools for a child session. */
export async function describeEvalTools(
	session: ToolSession,
	names: readonly string[],
	signal?: AbortSignal,
): Promise<EvalToolDescriptor[]> {
	const requested = [...new Set(names.filter(name => name.length > 0))];
	if (requested.length === 0) return [];
	if (!evalToolsEnabled(session)) {
		throw new ToolError("Eval-defined tools are disabled; set eval.tools.enabled=true to expose them to subagents.");
	}
	const tools = await queryAllEvalTools(session, requested, signal);
	const found = new Set(tools.map(tool => tool.name));
	const missing = requested.filter(name => !found.has(name));
	if (missing.length > 0) {
		const available = (await listEvalTools(session, signal))
			.map(tool => tool.name)
			.sort((left, right) => left.localeCompare(right));
		throw new ToolError(
			`Unknown eval tool(s): ${missing.join(", ")}. Define them with @tool (Python) or tool(fn, {…}) (JS) in an eval cell first. Available: ${available.join(", ") || "none"}`,
		);
	}
	const byName = new Map(tools.map(tool => [tool.name, tool]));
	return requested.flatMap(name => {
		const descriptor = byName.get(name);
		return descriptor ? [descriptor] : [];
	});
}

const BUILTIN_TOOL_NAME_LOOKUP: Record<string, true> = Object.fromEntries(
	BUILTIN_TOOL_NAMES.map(name => [normalizeToolName(name), true]),
);

/** Whether a requested name is a built-in tool (canonical spelling). */
export function isBuiltinToolName(name: string): boolean {
	return BUILTIN_TOOL_NAME_LOOKUP[normalizeToolName(name)] === true;
}

/**
 * Whether the selected agent's effective tool plan supplies a built-in tool
 * name. Uses the executor's plan (auto-added `task`/`wait`, `exec` expansion,
 * recursion limit), not the raw `tools` frontmatter.
 */
export function isBuiltinToolAvailable(name: string, agent: AgentDefinition, session: ToolSession): boolean {
	const canonical = normalizeToolName(name);
	if (BUILTIN_TOOL_NAME_LOOKUP[canonical] !== true) return false;
	const maxRecursionDepth = cfgTaskMaxRecursionDepth.get(session.settings);
	const childDepth = (session.taskDepth ?? 0) + 1;
	const plan = resolveSubagentToolNames(agent, {
		settings: session.settings,
		structured: true,
		atMaxDepth: maxRecursionDepth >= 0 && childDepth >= maxRecursionDepth,
		restrictToolNames: false,
	});
	return (plan ?? BUILTIN_TOOL_NAMES).map(normalizeToolName).includes(canonical);
}

/**
 * Remove built-in names from a spawn item's `tools` before eval validation,
 * recording them for a post-policy correction notice. `task.tools` accepts
 * eval-defined tools only; built-ins come from the selected agent's profile.
 */
export function stripBuiltinToolNames(item: { tools?: string[] }, record: WeakMap<object, string[]>): void {
	if (item.tools === undefined) return;
	const kept: string[] = [];
	const stripped: string[] = [];
	for (const name of item.tools) {
		// Malformed entries are left for the tool-shape validation to reject.
		if (typeof name === "string" && isBuiltinToolName(name)) stripped.push(normalizeToolName(name));
		else kept.push(name);
	}
	if (stripped.length === 0) return;
	item.tools = kept;
	record.set(item, stripped);
}

/** List every tool currently defined across retained eval kernels. */
export async function listEvalTools(session: ToolSession, signal?: AbortSignal): Promise<EvalToolDescriptor[]> {
	if (!evalToolsEnabled(session)) return [];
	return await queryAllEvalTools(session, [], signal);
}

function stripHarnessIntent(
	params: Record<string, unknown>,
	parameters: Record<string, unknown>,
): Record<string, unknown> {
	if (!Object.hasOwn(params, INTENT_FIELD)) return params;
	if (schemaDeclaresIntentField(parameters)) return params;
	const { [INTENT_FIELD]: _intent, ...args } = params;
	return args;
}

function resultText(value: unknown): string {
	if (typeof value === "string") return value || "(empty result)";
	if (value === null || value === undefined) return "(no result)";
	return JSON.stringify(value, null, 2) ?? String(value);
}

function errorResult(
	name: string,
	language: EvalToolDescriptor["language"],
	error: string,
): AgentToolResult<{ evalTool: string; language: EvalToolDescriptor["language"]; isError: boolean }> {
	return {
		content: [{ type: "text", text: error }],
		details: { evalTool: name, language, isError: true },
		isError: true,
	};
}

/** Materialize kernel-defined descriptors as custom tools for a child session. */
export function createEvalCustomTools(session: ToolSession, descriptors: EvalToolDescriptor[]): CustomTool[] {
	if (descriptors.length > 0 && !evalToolsEnabled(session)) {
		throw new ToolError("Eval-defined tools are disabled; set eval.tools.enabled=true to expose them to subagents.");
	}
	return descriptors.map(descriptor => ({
		name: descriptor.name,
		label: descriptor.name,
		description: descriptor.description,
		parameters: descriptor.parameters,
		loadMode: "essential",
		async execute(_toolCallId, rawParams, _onUpdate, _ctx, signal) {
			const params = isUnknownRecord(rawParams) ? rawParams : {};
			const args = stripHarnessIntent(params, descriptor.parameters);
			let result: EvalToolInvokeResult;
			try {
				if (descriptor.language === "python") {
					result = await callPythonTool(descriptor.name, args, {
						...resolvePythonKernelIdentity(session),
						toolSession: session,
						signal,
					});
				} else {
					const jsResult = await invokeJsTool(
						{ op: "call", name: descriptor.name, args },
						{ ...resolveJsKernelIdentity(session), session, signal },
					);
					result =
						"tools" in jsResult ? { ok: false, error: "JavaScript tool call returned a descriptor" } : jsResult;
				}
			} catch (error) {
				if (error instanceof EvalKernelNotRunningError) {
					return errorResult(descriptor.name, descriptor.language, error.message);
				}
				throw error;
			}
			if (!result.ok) return errorResult(descriptor.name, descriptor.language, result.error);
			return {
				content: [{ type: "text", text: resultText(result.value) }],
				details: { evalTool: descriptor.name, language: descriptor.language },
			};
		},
	}));
}
