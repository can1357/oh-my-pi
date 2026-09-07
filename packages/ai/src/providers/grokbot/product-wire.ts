/**
 * Product-shaped Grok Bot sand InferenceService wire helpers (mitm-validated).
 *
 * Field-2 tools use PascalCase names and `{ jsonSchema: … }` parameter envelopes.
 * Field-9 carries host tool allowlists; automation uses sand-automation + generalPurpose.
 */
import type { Context } from "../../types";
import { toolWireSchema } from "../../utils/schema/wire";

export type ProductWireProfile = "automation" | "parent-chat";

export type ProductWireTool = {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	customToolFormat?: { type: string; definition: string; syntax: string };
};

/** omp internal tool name → product field-2 wire name (captures 1–4). */
export const OMP_TO_SAND_FIELD2: Record<string, string> = {
	bash: "Shell",
	read: "Read",
	write: "Write",
	edit: "Write",
	grep: "Grep",
	glob: "Glob",
};

/**
 * When multiple omp tools share one sand field-2 name (including an extension
 * `customWireName` that collides with a built-in alias), prefer this omp owner
 * so advertised schema and dispatch index stay one-to-one.
 */
const SAND_FIELD2_PREFERRED_OMP: Readonly<Record<string, string>> = {
	Shell: "bash",
	Read: "read",
	Write: "write",
	Grep: "grep",
	Glob: "glob",
};

/** Field 9 allowlist from capture-1 / automation worker. */
export const FIELD9_ALLOWLIST_AUTOMATION = [
	"Task",
	"TodoWrite",
	"SendFeedback",
	"CreateAgent",
	"UpdateAgent",
	"CreateChannel",
	"UpdateChannel",
	"ListMachines",
	"WebSearch",
	"WebFetch",
	"GenerateImage",
	"CloudAgent",
	"AwaitShell",
	"CopyToBox",
	"CopyFromBox",
	"SearchPlugins",
	"GetPlugin",
	"UninstallMcpServer",
	"UninstallPlugin",
	"GetMcpServerStatus",
	"SetMcpInstructions",
	"RestartMcpServers",
	"RemoveMcpAccount",
	"RenameMcpAccount",
	"CheckSubagent",
	"MessageSubagent",
	"StopSubagent",
] as const;

/** Field 9 allowlist from capture-4 / parent sand-default chat. */
export const FIELD9_ALLOWLIST_PARENT = [
	"Task",
	"TodoWrite",
	"SendToAgent",
	"SendFeedback",
	"CreateAgent",
	"UpdateAgent",
	"create_bot_share_json",
	"CreateChannel",
	"UpdateChannel",
	"ListMachines",
	"WebSearch",
	"WebFetch",
	"GenerateImage",
	"CloudAgent",
	"AwaitShell",
	"CopyToBox",
	"CopyFromBox",
	"request_box_help",
	"SearchPlugins",
	"GetPlugin",
	"InstallPlugin",
	"AddMcpServer",
	"UninstallMcpServer",
	"UninstallPlugin",
	"GetMcpServerStatus",
	"SetMcpInstructions",
	"RestartMcpServers",
	"AuthenticateMcpServer",
	"RemoveMcpAccount",
	"RenameMcpAccount",
	"CheckSubagent",
	"MessageSubagent",
	"StopSubagent",
	"SendMessage",
] as const;

export const SEND_TO_USER_WIRE_NAME = "SendToUser";

export function wrapToolParameters(schema: Record<string, unknown>): Record<string, unknown> {
	return { jsonSchema: schema };
}

export function toSandField2Name(ompName: string): string {
	return OMP_TO_SAND_FIELD2[ompName] ?? ompName;
}

export function toOmpToolName(sandName: string): string {
	const preferred = SAND_FIELD2_PREFERRED_OMP[sandName];
	if (preferred) return preferred;
	for (const [omp, sand] of Object.entries(OMP_TO_SAND_FIELD2)) {
		if (sand === sandName) return omp;
	}
	return sandName;
}

export function field9AllowlistForProfile(profile: ProductWireProfile): readonly string[] {
	return profile === "parent-chat" ? FIELD9_ALLOWLIST_PARENT : FIELD9_ALLOWLIST_AUTOMATION;
}

function toolParametersToJson(tool: Tool): Record<string, unknown> {
	try {
		return toolWireSchema(tool);
	} catch {
		return { type: "object", properties: {} };
	}
}

type Tool = NonNullable<Context["tools"]>[number];

function mapOmpToolToProduct(tool: Tool): ProductWireTool | undefined {
	if (!tool || typeof tool !== "object") return undefined;
	const name = typeof tool.name === "string" ? tool.name : "";
	if (!name) return undefined;
	const wireName =
		typeof tool.customWireName === "string" && tool.customWireName.trim()
			? tool.customWireName.trim()
			: toSandField2Name(name);
	const schema = toolParametersToJson(tool);
	// Cursor/Gemini Write often uses `contents` instead of omp `content`.
	// Advertise both so product Write calls populate omp `content`.
	// Clone before augmenting — `toolWireSchema` may return a memoized object
	// shared with native-wire / other providers.
	let parametersSchema = schema;
	if ((name === "write" || wireName === "Write") && schema.properties && typeof schema.properties === "object") {
		const props = schema.properties as Record<string, unknown>;
		if (props.content && !props.contents) {
			parametersSchema = {
				...schema,
				properties: {
					...props,
					contents: {
						type: "string",
						description: "File contents (alias of content)",
					},
				},
			};
		}
	}
	const entry: ProductWireTool = {
		name: wireName,
		description: typeof tool.description === "string" ? tool.description : "",
		parameters: wrapToolParameters(parametersSchema),
	};
	if (tool.customFormat && typeof tool.customFormat === "object") {
		entry.customToolFormat = {
			type: "grammar",
			definition: tool.customFormat.definition || "",
			syntax: tool.customFormat.syntax || "",
		};
	}
	return entry;
}

/** SendToUser tool from capture-4 (parent chat visible replies). */
export function sendToUserProductTool(): ProductWireTool {
	return {
		name: SEND_TO_USER_WIRE_NAME,
		description: "Send a user-visible message. The user cannot see tool output or your thinking — only SendToUser.",
		parameters: wrapToolParameters({
			type: "object",
			properties: {
				type: {
					type: "string",
					enum: ["text"],
					description: "text for chat messages visible to the user",
				},
				content: {
					type: "string",
					description: "Message content the user will see",
				},
			},
			required: ["type", "content"],
		}),
	};
}

/**
 * Map omp catalog tools to product field-2 tools with jsonSchema envelopes.
 * Parent profile injects SendToUser when absent.
 * Shared sand names (edit+write → Write) keep the preferred omp owner's schema.
 */
export function toProductField2Tools(tools: Context["tools"], profile: ProductWireProfile): ProductWireTool[] {
	const out: ProductWireTool[] = [];
	const seen = new Map<string, string>();
	if (!Array.isArray(tools)) {
		if (profile === "parent-chat") out.push(sendToUserProductTool());
		return out;
	}
	for (const tool of tools) {
		const ompName = typeof tool?.name === "string" ? tool.name : "";
		const mapped = mapOmpToolToProduct(tool);
		if (!mapped || !ompName) continue;
		const previousOmp = seen.get(mapped.name);
		if (previousOmp !== undefined) {
			const preferred = SAND_FIELD2_PREFERRED_OMP[mapped.name];
			if (preferred !== ompName) continue;
			const idx = out.findIndex(entry => entry.name === mapped.name);
			if (idx >= 0) out[idx] = mapped;
			seen.set(mapped.name, ompName);
			continue;
		}
		seen.set(mapped.name, ompName);
		out.push(mapped);
	}
	if (profile === "parent-chat" && !seen.has(SEND_TO_USER_WIRE_NAME)) {
		out.unshift(sendToUserProductTool());
	}
	return out;
}

/** Tool-index entry used while decoding product sand streams. */
export type ProductWireToolIndexMeta = {
	name: string;
	/** Grammar/customFormat wire discriminator — never a product PascalCase alias. */
	customWireName?: string;
	/** Product field-2 alias (Shell/Read/Write) for lookup only; not persisted. */
	productWireName?: string;
	isGrammar: boolean;
};

/** Extend grammar tool index so Shell/Read wire names resolve to omp bash/read. */
export function augmentToolIndexForProductWire(
	index: Map<string, ProductWireToolIndexMeta>,
	tools: Context["tools"],
): void {
	if (!Array.isArray(tools)) return;
	for (const tool of tools) {
		if (!tool || typeof tool !== "object") continue;
		const name = typeof tool.name === "string" ? tool.name : "";
		if (!name) continue;
		const customWire =
			typeof tool.customWireName === "string" && tool.customWireName.trim()
				? tool.customWireName.trim()
				: undefined;
		const sandName = customWire ?? toSandField2Name(name);
		const meta = index.get(name);
		if (!meta || sandName === name) continue;
		// Keep product aliases off `customWireName` — that marker means grammar /
		// custom_tool_call for openai-shared and TUI previews. Index by product
		// wire name for stream decode only.
		const wired: ProductWireToolIndexMeta = { ...meta, productWireName: sandName };
		index.set(name, wired);
		const existing = index.get(sandName);
		const preferred = SAND_FIELD2_PREFERRED_OMP[sandName];
		if (existing && preferred && preferred !== name && existing.name === preferred) {
			// Keep the preferred omp owner on the shared sand name.
			continue;
		}
		index.set(sandName, wired);
	}
}

/**
 * Rewrite historical inference tool call/result names to product field-2 aliases
 * (bash→Shell, read→Read, write/edit→Write) so replayed history matches the
 * advertised product-wire schema. Does not mutate the input array.
 */
export function rewriteInferenceMessagesForProductWire(
	messages: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
	return messages.map(msg => {
		if (!msg || typeof msg !== "object") return msg;
		const toolCalls = Reflect.get(msg, "toolCalls");
		if (Array.isArray(toolCalls)) {
			return {
				...msg,
				toolCalls: toolCalls.map(entry => {
					if (!entry || typeof entry !== "object") return entry;
					const tc = entry as Record<string, unknown>;
					const name = typeof tc.toolName === "string" ? tc.toolName : "";
					if (!name) return tc;
					const sandName = toSandField2Name(name);
					return sandName === name ? tc : { ...tc, toolName: sandName };
				}),
			};
		}
		const toolContent = Reflect.get(msg, "toolContent");
		if (toolContent && typeof toolContent === "object") {
			const parts = Reflect.get(toolContent, "parts");
			if (Array.isArray(parts)) {
				return {
					...msg,
					toolContent: {
						...(toolContent as Record<string, unknown>),
						parts: parts.map(part => {
							if (!part || typeof part !== "object") return part;
							const p = part as Record<string, unknown>;
							const name = typeof p.toolName === "string" ? p.toolName : "";
							if (!name) return p;
							const sandName = toSandField2Name(name);
							return sandName === name ? p : { ...p, toolName: sandName };
						}),
					},
				};
			}
		}
		return msg;
	});
}

/** Parse SendToUser streaming args JSON; returns visible text when complete enough. */
export function parseSendToUserContent(argsText: string): string | undefined {
	if (!argsText.trim()) return undefined;
	try {
		const parsed = JSON.parse(argsText) as { type?: string; content?: string };
		if (parsed.type === "text" && typeof parsed.content === "string") return parsed.content;
	} catch {
		// partial JSON — try regex fallback for content field during stream
		const match = /"content"\s*:\s*"((?:\\.|[^"\\])*)"/s.exec(argsText);
		if (match?.[1]) {
			try {
				return JSON.parse(`"${match[1]}"`) as string;
			} catch {
				return match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
			}
		}
	}
	return undefined;
}
