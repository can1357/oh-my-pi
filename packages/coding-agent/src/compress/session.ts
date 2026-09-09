/**
 * Session factory for `omp compress`.
 *
 * Deliberately minimal: two custom tools, no extensions, no MCP, no IRC, no LSP,
 * no file or shell access. Everything the agent needs arrives in the conversation,
 * so nothing outside the source text can influence the output.
 */
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { formatModelString, resolveCliModel } from "../config/model-resolver";
import { Settings } from "../config/settings";
import { createAgentSession, discoverAuthStorage } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import systemPrompt from "./prompts/system.md" with { type: "text" };
import type { CompressProtocol } from "./protocol";

/** A live compress session plus the resolved model label used in reporting. */
export interface CompressSession {
	session: AgentSession;
	model: string;
}

/** Resolve the requested model and open a session restricted to the two protocol tools. */
export async function createCompressSession(options: {
	cwd?: string;
	model?: string;
	protocol: CompressProtocol;
	/** Distinct per concurrent session; agent ids must be unique within a process. */
	agentId?: string;
}): Promise<CompressSession> {
	const cwd = options.cwd ?? getProjectDir();
	const [settings, authStorage] = await Promise.all([Settings.init({ cwd }), discoverAuthStorage()]);
	const modelRegistry = new ModelRegistry(authStorage);
	await modelRegistry.refresh();
	// An absent selector means "whatever the session is configured to use", which
	// resolveCliModel reports as a model-less, error-less result.
	const resolved = options.model ? resolveCliModel({ cliModel: options.model, modelRegistry, settings }) : undefined;
	if (resolved && (resolved.error || !resolved.model)) {
		throw new Error(resolved.error ?? `Model "${options.model}" not found`);
	}
	const { session } = await createAgentSession({
		cwd,
		settings,
		authStorage,
		modelRegistry,
		...(resolved?.model ? { model: resolved.model } : {}),
		customTools: [options.protocol.rewriteTool(), options.protocol.approveTool()],
		toolNames: ["rewrite", "approve"],
		restrictToolNames: true,
		allowRestrictedCustomTools: true,
		// Replace the default blocks outright: a compressor needs its own contract, not
		// the coding-agent workflow. Every discovery source below defaults to ON when
		// omitted, and each one would inject instruction-shaped project text into a
		// session whose only legitimate input is the source document.
		systemPrompt: [systemPrompt.trim()],
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableIrc: false,
		enableLsp: false,
		hasUI: false,
		autoApprove: true,
		agentId: options.agentId ?? "Compress",
		agentDisplayName: "compress",
	});
	const active = resolved?.model ?? session.model;
	return { session, model: active ? formatModelString(active) : "session default" };
}
