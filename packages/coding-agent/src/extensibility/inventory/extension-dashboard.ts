import type { ExtensionInspectorSource } from "./inspector-model";
import type { MCPRuntimeSource } from "./mcp-runtime";
import { type Extension, type ExtensionProvider } from "./types";

/** Runtime operations remain owned by the embedding application. */
export interface ExtensionDashboardRuntime {
	getDisabledExtensions(): string[];
	setDisabledExtensions(ids: string[]): void;
	getProviders(): readonly ExtensionProvider[];
	loadExtensions(disabledIds: string[]): Promise<Extension[]>;
	toggleProvider(providerId: string): boolean;
	toggleUserSource(providerId: string): boolean;
	persistMcpToggle(name: string, enabled: boolean, sourcePath?: string): Promise<void>;
	applyMcpToggle(name: string, enabled: boolean): Promise<void>;
	subscribeMcpChanges(onChange: () => void): Array<() => void>;
	mcpSource?: MCPRuntimeSource;
	inspectorSource?: ExtensionInspectorSource;
}
