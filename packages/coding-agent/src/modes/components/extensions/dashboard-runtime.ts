import type { ExtensionDashboardRuntime } from "@oh-my-pi/pi-tui/overlays/extensions/extension-dashboard";
import { getMCPConfigPath } from "@oh-my-pi/pi-utils";
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
	browserMcpFilterEnabled?: () => boolean;
}): ExtensionDashboardRuntime {
	const { cwd, settings, mcpManager, eventBus, onMcpToolsChanged, browserMcpFilterEnabled } = options;
	return {
		getDisabledExtensions: () => settings.get("disabledExtensions") ?? [],
		setDisabledExtensions: ids => settings.set("disabledExtensions", ids),
		getProviders: () =>
			getAllProvidersInfo().map(provider => ({
				...provider,
				userSourceEnabled: isUserSourceEnabled(provider.id),
				foreignUserSource: isForeignUserProvider(provider.id),
			})),
		loadExtensions: disabledIds => loadAllExtensions(cwd, disabledIds),
		toggleProvider,
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
