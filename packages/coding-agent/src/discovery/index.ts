/**
 * Discovery Module
 *
 * Auto-registers all providers by importing them.
 * Import this module to ensure all providers are registered with the capability registry.
 */

// Import capability definitions (ensures capabilities are defined before providers register)
import "../capability/context-file";
import "../capability/extension";
import "../capability/hook";
import "../capability/instruction";
import "../capability/mcp";
import "../capability/prompt";
import "../capability/rule";
import "../capability/settings";
import "../capability/skill";
import "../capability/slash-command";
import "../capability/system-prompt";
import "../capability/tool";

// Import providers (each registers itself on import)
import "./builtin";
import "./claude";
import "./codex";
import "./gemini";
import "./cursor";
import "./windsurf";
import "./cline";
import "./github";
import "./vscode";
import "./agents-md";
import "./mcp-json";

export type { ContextFile } from "../capability/context-file";
export type { Extension, ExtensionManifest } from "../capability/extension";
export type { Hook } from "../capability/hook";
// Re-export the main API from capability registry
export {
	cacheStats,
	// Provider management
	disableProvider,
	enableProvider,
	getAllCapabilitiesInfo,
	getAllProvidersInfo,
	// Introspection
	getCapability,
	getCapabilityInfo,
	getDisabledProviders,
	getProviderInfo,
	// Initialization
	initializeWithSettings,
	invalidate,
	isProviderEnabled,
	listCapabilities,
	// Loading API
	load,
	loadSync,
	// Cache management
	reset,
	setDisabledProviders,
} from "../capability/index";
export type { Instruction } from "../capability/instruction";
// Re-export capability item types
export type { MCPServer } from "../capability/mcp";
export type { Prompt } from "../capability/prompt";
export type { Rule, RuleFrontmatter } from "../capability/rule";
export type { Settings } from "../capability/settings";
export type { Skill, SkillFrontmatter } from "../capability/skill";
export type { SlashCommand } from "../capability/slash-command";
export type { SystemPrompt } from "../capability/system-prompt";
export type { CustomTool } from "../capability/tool";
// Re-export types
export type {
	Capability,
	CapabilityInfo,
	CapabilityResult,
	LoadContext,
	LoadOptions,
	LoadResult,
	Provider,
	ProviderInfo,
	SourceMeta,
} from "../capability/types";
