import type {
	MCPActionExecutionContext,
	MCPActionId,
	MCPActionItem,
	MCPActionPanelRuntime,
	MCPActionPanelState,
} from "@oh-my-pi/pi-tui/overlays/extensions/mcp-action-panel";
import { snapshotMcpRuntime } from "@oh-my-pi/pi-tui/overlays/extensions/mcp-runtime";
import { isShadowedExtension, type Extension } from "@oh-my-pi/pi-tui/overlays/extensions/types";
import type { EffectiveExtensionRoots } from "../../../capability/types";
import type { MCPServer } from "../../../capability/mcp";
import type { Settings } from "../../../config/settings";
import type { CustomTool } from "../../../extensibility/custom-tools/types";
import { classifyMCPServer } from "../../../mcp/auth-capability";
import { mcpServerToConfig } from "../../../mcp/config";
import type { MCPManager } from "../../../mcp/manager";
import { MCPServerActions, type MCPServerActionTarget } from "../../../mcp/server-actions";
import type { AuthStorage } from "../../../session/auth-storage";
import { copyToClipboard } from "../../../utils/clipboard";
import type { EventBus } from "../../../utils/event-bus";
import { openPath } from "../../../utils/open";
import { MCP_CONNECTION_STATUS_EVENT_CHANNEL } from "../../../mcp/startup-events";
import { loadAllExtensions } from "./state-manager";

export interface CreateMCPActionRuntimeOptions {
	cwd: string;
	settings: Settings;
	mcpManager?: MCPManager;
	authStorage: AuthStorage;
	eventBus?: EventBus;
	onMcpToolsChanged?: (tools: CustomTool[]) => Promise<void> | void;
	clearMcpPromptCommands?(): void;
	browserMcpFilterEnabled?: () => boolean;
	getExtensionRoots?: () => EffectiveExtensionRoots;
	hasPendingManualOAuth?: () => boolean;
}

function serverFromExtension(extension: Extension): MCPServer {
	const server = extension.raw as Partial<MCPServer> | null;
	if (!server || server.name !== extension.name || !server._source) {
		throw new Error(`MCP server configuration is unavailable for ${extension.name}`);
	}
	return server as MCPServer;
}

function targetFromExtension(extension: Extension, manager?: MCPManager): MCPServerActionTarget {
	const server = serverFromExtension(extension);
	const managerSource = manager?.getSource(extension.name);
	const managerConfig = managerSource?.path === extension.path ? manager?.getServerConfig(extension.name) : undefined;
	return {
		name: extension.name,
		config: managerConfig ?? mcpServerToConfig(server),
		source: server._source,
		disabled: extension.state === "disabled",
		shadowed: extension.state === "shadowed" || Boolean((server as MCPServer & { _shadowed?: boolean })._shadowed),
	};
}

function action(
	id: MCPActionId,
	label: string,
	description: string,
	enabled: boolean,
	disabledReason?: string,
	requiresConfirmation = false,
): MCPActionItem {
	return { id, label, description, enabled, disabledReason, requiresConfirmation };
}

export function createMCPActionRuntime(options: CreateMCPActionRuntimeOptions): MCPActionPanelRuntime {
	const {
		cwd,
		settings,
		mcpManager,
		authStorage,
		eventBus,
		onMcpToolsChanged,
		clearMcpPromptCommands,
		browserMcpFilterEnabled,
		getExtensionRoots,
		hasPendingManualOAuth,
	} = options;
	const actions = new MCPServerActions({
		cwd,
		manager: mcpManager,
		authStorage,
		enableProjectConfig: settings.get("mcp.enableProjectConfig") ?? true,
		filterExa: true,
		filterBrowser: browserMcpFilterEnabled?.() ?? false,
		getExtensionRoots,
		onStatus: event => eventBus?.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, event),
		refreshMCPTools: tools => onMcpToolsChanged?.(tools),
		clearMCPPromptCommands: clearMcpPromptCommands,
	});
	const latestExtensions = new Map<string, Extension>();
	const refreshExtension = async (extension: Extension): Promise<Extension> => {
		const loaded = await loadAllExtensions(cwd, settings.get("disabledExtensions") ?? []);
		const current =
			loaded.find(item => item.id === extension.id && item.path === extension.path && !isShadowedExtension(item)) ??
			loaded.find(item => item.id === extension.id && !isShadowedExtension(item)) ??
			extension;
		latestExtensions.set(extension.id, current);
		return current;
	};

	const loadState = async (extension: Extension): Promise<MCPActionPanelState> => {
		const current = await refreshExtension(extension);
		const target = targetFromExtension(current, mcpManager);
		const server = serverFromExtension(current);
		const snapshot = snapshotMcpRuntime(server, mcpManager, {
			enabled: !target.disabled,
			shadowed: target.shadowed,
		});
		const capabilities = classifyMCPServer({
			config: target.config,
			source: target.source,
			authStorage,
			disabled: target.disabled,
			shadowed: target.shadowed,
		});
		const toggleId = target.disabled ? "enable" : "disable";
		const actionItems: MCPActionItem[] = [
			action(
				"test",
				"Test connection",
				"Verify the server and list its tools",
				capabilities.canTest,
				target.disabled ? "Enable the server first" : undefined,
			),
			action(
				"reconnect",
				"Reconnect",
				"Restart the live connection",
				capabilities.canReconnect && Boolean(mcpManager),
				!mcpManager
					? "MCP runtime manager is unavailable"
					: target.disabled
						? "Enable the server first"
						: undefined,
			),
			action(
				"reauthenticate",
				"Reauthenticate",
				"Run OMP-managed OAuth",
				capabilities.canReauthenticate,
				capabilities.reauthenticateUnavailableReason,
			),
			action(
				"clear-authentication",
				"Clear authentication",
				"Remove OMP-managed OAuth credentials",
				capabilities.canClearAuthentication,
				"No OMP-managed OAuth credential found",
				true,
			),
			action(
				toggleId,
				target.disabled ? "Enable server" : "Disable server",
				target.disabled ? "Persist and connect this server" : "Persist and disconnect this server",
				capabilities.canToggle,
				target.shadowed ? "Shadowed rows cannot be changed" : undefined,
				!target.disabled,
			),
		];
		return {
			name: current.name,
			connectionStatus: target.disabled
				? "disabled"
				: snapshot.health === "inactive"
					? "disconnected"
					: snapshot.health,
			transport: snapshot.transport,
			source: `${current.source.providerName} · ${current.path}`,
			authentication: capabilities.authenticationSummary,
			tools: snapshot.tools.length,
			prompts: snapshot.prompts.length,
			resources: snapshot.resources.length,
			lastError: mcpManager?.getLastConnectionError(current.name),
			actions: actionItems,
		};
	};

	return {
		loadState,
		async runAction(
			extension: Extension,
			actionId: MCPActionId,
			context: MCPActionExecutionContext,
		): Promise<string> {
			const target = targetFromExtension(latestExtensions.get(extension.id) ?? extension, mcpManager);
			switch (actionId) {
				case "test": {
					context.onProgress(`Testing ${target.name}...`);
					return (await actions.test(target, context.signal)).message;
				}
				case "reconnect": {
					context.onProgress(`Reconnecting ${target.name}...`);
					return (await actions.reconnect(target, context.signal)).message;
				}
				case "reauthenticate": {
					if (hasPendingManualOAuth?.()) throw new Error("Another OAuth login is waiting for manual input");
					context.onProgress(`Starting OAuth for ${target.name}...`);
					const result = await actions.reauthenticate(
						target,
						{
							onAuthorization: info => {
								context.onAuthorization(info);
								openPath(info.url);
								void copyToClipboard(info.url).catch(() => undefined);
							},
							onProgress: context.onProgress,
							requestManualInput: context.requestManualInput,
							onComplete: () => undefined,
						},
						context.signal,
					);
					return result.message;
				}
				case "clear-authentication":
					context.onProgress(`Clearing authentication for ${target.name}...`);
					return (await actions.clearAuthentication(target)).message;
				case "enable":
					context.onProgress(`Enabling ${target.name}...`);
					return (await actions.setEnabled(target, true)).message;
				case "disable":
					context.onProgress(`Disabling ${target.name}...`);
					return (await actions.setEnabled(target, false)).message;
			}
		},
	};
}
