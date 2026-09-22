import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentsHubDeps } from "@oh-my-pi/pi-tui/overlays/agents-hub";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { isEnoent, prompt } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import type { EffectiveExtensionRoots } from "../capability/types";
import { getConfigDirs } from "../config";
import type { ModelRegistry } from "../config/model-registry";
import {
	resolveAgentAdvisorSelection,
	resolveAgentModelPatterns,
	resolveAgentPrewalkPattern,
	resolveConfiguredModelPatterns,
	resolveModelOverride,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";
import agentCreationArchitectPrompt from "../prompts/system/agent-creation-architect.md" with { type: "text" };
import agentCreationUserPrompt from "../prompts/system/agent-creation-user.md" with { type: "text" };
import { createAgentSession } from "../sdk";
import { refreshAgentDiscovery } from "../task";
import { discoverAgents } from "../task/discovery";
import { resolveAgentPrewalkDefault } from "../task/prewalk";
import { createModelBrowserSource } from "./model-browser-source";

function extractAssistantText(messages: AgentMessage[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const blocks = message.content;
		if (!Array.isArray(blocks)) continue;
		const text = blocks
			.map(block => {
				if (!block || typeof block !== "object") return "";
				if (!("type" in block) || block.type !== "text" || !("text" in block)) return "";
				const value = block.text;
				return typeof value === "string" ? value : "";
			})
			.join("\n")
			.trim();
		if (text.length > 0) return text;
	}
	return null;
}

export function createAgentsHubDeps(
	cwd: string,
	settings: Settings,
	modelRegistry: ModelRegistry,
	extensionRoots: () => EffectiveExtensionRoots,
	activeModelPattern?: string,
	defaultModelPattern?: string,
): AgentsHubDeps {
	return {
		browserSource: createModelBrowserSource(settings),
		loadAgents: async () => {
			const { agents } = await discoverAgents(cwd, undefined, extensionRoots());
			const disabled = new Set(settings.get("task.disabledAgents") ?? []);
			const overrides = settings.get("task.agentModelOverrides") ?? {};
			const prewalkOverrides = settings.get("task.agentPrewalk") ?? {};
			const advisorOverrides = settings.get("task.agentAdvisor") ?? {};
			return agents.map(agent => {
				const override = overrides[agent.name];
				const overrideModel = (Array.isArray(override) ? override.join(",") : (override ?? "")).trim();
				return {
					...agent,
					disabled: disabled.has(agent.name),
					overrideModel: overrideModel || undefined,
					prewalkOverride: prewalkOverrides[agent.name]?.trim() || undefined,
					advisorOverride: advisorOverrides[agent.name]?.trim() || undefined,
				};
			});
		},
		getAvailableModels: () => modelRegistry.getAvailable(),
		effectiveModelPatterns: agent =>
			resolveAgentModelPatterns({
				settingsOverride: agent.overrideModel,
				agentModel: agent.model,
				settings,
				activeModelPattern,
				fallbackModelPattern: defaultModelPattern,
			}),
		resolvePatterns: patterns => {
			if (patterns.length === 0) return undefined;
			const { model, thinkingLevel, explicitThinkingLevel } = resolveModelOverride(
				patterns,
				modelRegistry,
				settings,
			);
			if (!model) return undefined;
			const level = explicitThinkingLevel && thinkingLevel ? `:${thinkingLevel}` : "";
			return `${model.provider}/${model.id}${level}`;
		},
		effectivePrewalkPattern: agent =>
			resolveAgentPrewalkPattern({
				settingsOverride: agent.prewalkOverride,
				agentPrewalk: resolveAgentPrewalkDefault(agent, settings.get("task.prewalk") ?? false),
			}),
		effectiveAdvisorPattern: agent => {
			const selection = resolveAgentAdvisorSelection({
				settingsOverride: agent.advisorOverride,
				agentAdvisor: agent.advisor,
			});
			return selection ? (selection.model ?? "@advisor") : undefined;
		},
		setDisabledAgents: names => settings.set("task.disabledAgents", names),
		setOverrides: (property, overrides) => {
			const key =
				property === "model"
					? "task.agentModelOverrides"
					: property === "prewalk"
						? "task.agentPrewalk"
						: "task.agentAdvisor";
			settings.set(key, overrides);
		},
		generateAgent: async (description, onText) => {
			await modelRegistry.refresh();
			const patterns = resolveConfiguredModelPatterns(
				activeModelPattern ?? defaultModelPattern ?? settings.getModelRole("default"),
				settings,
			);
			const { model } = resolveModelOverride(patterns, modelRegistry, settings);
			const selectedModel = model ?? modelRegistry.getAvailable()[0];
			if (!selectedModel) throw new Error("No available model to generate agent specification.");
			const { session } = await createAgentSession({
				cwd,
				authStorage: modelRegistry.authStorage,
				modelRegistry,
				settings,
				model: selectedModel,
				systemPrompt: [prompt.render(agentCreationArchitectPrompt, {})],
				hasUI: false,
				enableLsp: false,
				enableMCP: false,
				disableExtensionDiscovery: true,
				toolNames: ["__none__"],
				customTools: [],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
			});
			const unsubscribe = session.subscribe(event => {
				if (event.type === "message_update" && "assistantMessageEvent" in event) {
					const ame = event.assistantMessageEvent;
					if (ame.type === "text_delta") onText(ame.delta);
				}
			});
			try {
				await session.prompt(prompt.render(agentCreationUserPrompt, { request: description }), {
					expandPromptTemplates: false,
				});
				const raw = extractAssistantText(session.state.messages);
				if (!raw) throw new Error("No response returned by agent creation architect.");
				return raw;
			} finally {
				unsubscribe();
				await session.dispose();
			}
		},
		saveAgent: async (scope, spec) => {
			const dirs = getConfigDirs("agents", { user: scope === "user", project: scope === "project", cwd });
			const targetDir = dirs[0]?.path;
			if (!targetDir) throw new Error(`Cannot resolve ${scope} agents directory.`);
			const filePath = path.join(targetDir, `${spec.identifier}.md`);
			try {
				await fs.stat(filePath);
				throw new Error(`Agent file already exists: ${shortenPath(filePath)}`);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
			const frontmatter = YAML.stringify({ name: spec.identifier, description: spec.whenToUse }, null, 2).trimEnd();
			await Bun.write(filePath, `---\n${frontmatter}\n---\n\n${spec.systemPrompt.trim()}\n`);
			await refreshAgentDiscovery(cwd, extensionRoots());
			return filePath;
		},
	};
}
