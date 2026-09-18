import type { ExtensionDashboardRuntime } from "@oh-my-pi/pi-tui/overlays/extensions/extension-dashboard";
import { getMCPConfigPath, logger, Serial } from "@oh-my-pi/pi-utils";
import { parseRuleAgents, parseRuleConditionAndScope } from "../../../capability/rule";
import type { Settings } from "../../../config/settings";
import { getAllProvidersInfo, isForeignUserProvider, isUserSourceEnabled } from "../../../discovery";
import type { CustomTool } from "../../../extensibility/custom-tools/types";
import { setMcpServerEnabled } from "../../../mcp/config-writer";
import type { MCPManager } from "../../../mcp/manager";
import { MCP_CONNECTION_STATUS_EVENT_CHANNEL } from "../../../mcp/startup-events";
import type { EventBus } from "../../../utils/event-bus";
import { toolFileHeaderDescription } from "./inspector-runtime";
import { applyMcpToggleRuntime } from "./mcp-runtime";
import { loadAllExtensions, toggleProvider, toggleUserSource } from "./state-manager";

/** Bind the dashboard's display-only contract to the live application. */
export function createExtensionDashboardRuntime(options: {
	cwd: string;
	settings: Settings;
	mcpManager?: MCPManager;
	eventBus?: EventBus;
	onMcpToolsChanged?: (tools: CustomTool[]) => Promise<void> | void;
	onSkillsChanged?: () => Promise<void>;
	browserMcpFilterEnabled?: () => boolean;
}): ExtensionDashboardRuntime {
	const { cwd, settings, mcpManager, eventBus, onMcpToolsChanged, onSkillsChanged, browserMcpFilterEnabled } = options;
	const skillsRefresh = new Serial();
	let pendingSkillsRefresh = Promise.resolve();
	const refreshSkills = () => {
		if (!onSkillsChanged) return;
		pendingSkillsRefresh = skillsRefresh.run(onSkillsChanged).catch(error => {
			logger.warn("Failed to refresh skills after extension toggle", { error: String(error) });
		});
	};
	return {
		getDisabledExtensions: () => settings.get("disabledExtensions") ?? [],
		setDisabledExtensions(ids) {
			const previous = new Set((settings.get("disabledExtensions") ?? []).filter(id => id.startsWith("skill:")));
			const next = new Set(ids.filter(id => id.startsWith("skill:")));
			settings.set("disabledExtensions", ids);
			if (previous.size !== next.size || [...next].some(id => !previous.has(id))) refreshSkills();
		},
		getProviders: () =>
			getAllProvidersInfo().map(provider => ({
				...provider,
				userSourceEnabled: isUserSourceEnabled(provider.id),
				foreignUserSource: isForeignUserProvider(provider.id),
			})),
		async loadExtensions(disabledIds) {
			await pendingSkillsRefresh;
			return loadAllExtensions(cwd, disabledIds);
		},
		toggleProvider(providerId) {
			const enabled = toggleProvider(providerId);
			refreshSkills();
			return enabled;
		},
		toggleUserSource,
		async persistMcpToggle(name, enabled, sourcePath) {
			await setMcpServerEnabled({
				userPath: getMCPConfigPath("user", cwd),
				projectPath: getMCPConfigPath("project", cwd),
				sourcePath,
				name,
				enabled,
			});
		},
		applyMcpToggle: (name, enabled) =>
			applyMcpToggleRuntime({
				name,
				enabled,
				cwd,
				manager: mcpManager,
				session: onMcpToolsChanged ? { refreshMCPTools: onMcpToolsChanged } : undefined,
				discovery: {
					enableProjectConfig: settings.get("mcp.enableProjectConfig") ?? true,
					filterExa: true,
					filterBrowser: browserMcpFilterEnabled?.() ?? false,
				},
				onStatus: event => eventBus?.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, event),
			}),
		subscribeMcpChanges(onChange) {
			const subscriptions: Array<() => void> = [];
			if (eventBus) subscriptions.push(eventBus.on(MCP_CONNECTION_STATUS_EVENT_CHANNEL, onChange));
			if (mcpManager)
				subscriptions.push(
					mcpManager.addNotificationListener(onChange),
					mcpManager.addConnectionStatusListener(onChange),
					mcpManager.addCatalogChangeListener(onChange),
				);
			return subscriptions;
		},
		mcpSource: mcpManager,
		inspectorSource: {
			readToolHeader: toolFileHeaderDescription,
			parseRule: raw => ({ ...parseRuleConditionAndScope(raw), agents: parseRuleAgents(raw.agents) }),
		},
	};
}
