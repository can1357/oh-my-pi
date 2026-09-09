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
import { ToolError } from "../tools/tool-errors";
import { schemaDeclaresIntentField } from "../utils/tool-schema";

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
	return session.settings.get("eval.tools.enabled") !== false;
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
