/**
 * State manager for the Extension Control Center.
 * Handles data loading, tree building, filtering, and toggle persistence.
 */
import * as path from "node:path";
import { getMCPConfigPath, logger } from "@oh-my-pi/pi-utils";
import type { ContextFile } from "../../../capability/context-file";
import type { ExtensionModule } from "../../../capability/extension-module";
import type { Hook } from "../../../capability/hook";
import type { MCPServer } from "../../../capability/mcp";
import type { Prompt } from "../../../capability/prompt";
import type { Rule } from "../../../capability/rule";
import type { Skill } from "../../../capability/skill";
import type { SlashCommand } from "../../../capability/slash-command";
import type { CustomTool } from "../../../capability/tool";
import type { SourceMeta } from "../../../capability/types";
import {
	disableProvider,
	disableUserSource,
	enableProvider,
	enableUserSource,
	isProviderEnabled,
	isUserSourceEnabled,
	loadCapability,
} from "../../../discovery";
import { readDisabledServers, readEnabledServers } from "../../../mcp/config-writer";
import { commandPreview } from "@oh-my-pi/pi-tui/overlays/extensions/inspector-model";
import { inferMcpTransport } from "@oh-my-pi/pi-tui/overlays/extensions/mcp-runtime";
import {
	type DisabledReason,
	type Extension,
	type ExtensionKind,
	type ExtensionState,
	makeExtensionId,
	sourceFromMeta,
} from "@oh-my-pi/pi-tui/overlays/extensions/types";

/**
 * Provider-level gate for one discovered item: the whole-provider switch, plus
 * the `~/` opt-in for user-level items of foreign tools. Item-level disable and
 * shadowing take precedence and are decided by the caller.
 *
 * Mirrors the loader's foreign gate (`allowedRoots` / `isSourceEnabled`,
 * #10666/#10743): a user-scope `claude-plugins` item whose `origin` is not the
 * foreign `~/.claude` tree is an omp-native marketplace root under
 * `~/.omp/plugins` and loads without the opt-in — so the dashboard must render
 * it active, not a phantom `user-opt-in` disabled (#12776).
 */
function resolveState(
	source: SourceMeta,
	isDisabled: boolean,
	isShadowed: boolean | undefined,
): { state: ExtensionState; disabledReason?: DisabledReason } {
	if (isDisabled) return { state: "disabled", disabledReason: "item-disabled" };
	if (isShadowed) return { state: "shadowed", disabledReason: "shadowed" };
	if (!isProviderEnabled(source.provider)) return { state: "disabled", disabledReason: "provider-disabled" };
	if (source.provider === "claude-plugins" && source.origin !== undefined && source.origin !== "claude") {
		return { state: "active" };
	}
	if (source.level === "user" && !isUserSourceEnabled(source.provider)) {
		return { state: "disabled", disabledReason: "user-opt-in" };
	}
	return { state: "active" };
}

/**
 * Load all extensions from all capabilities.
 */
export async function loadAllExtensions(cwd?: string, disabledIds?: string[]): Promise<Extension[]> {
	const extensions: Extension[] = [];
	const effectiveDisabledIds = disabledIds ?? [];
	const disabledExtensions = new Set<string>(effectiveDisabledIds);

	// Helper to convert capability items to extensions
	function addItems<T extends { name: string; path: string; _source: SourceMeta }>(
		items: T[],
		kind: ExtensionKind,
		opts?: {
			getDescription?: (item: T) => string | undefined;
			getTrigger?: (item: T) => string | undefined;
			getShadowedBy?: (item: T) => string | undefined;
		},
	): void {
		for (const item of items) {
			const id = makeExtensionId(kind, item.name);
			const { state, disabledReason } = resolveState(
				item._source,
				disabledExtensions.has(id),
				(item as { _shadowed?: boolean })._shadowed,
			);

			extensions.push({
				id,
				kind,
				name: item.name,
				displayName: item.name,
				description: opts?.getDescription?.(item),
				trigger: opts?.getTrigger?.(item),
				path: item.path,
				source: sourceFromMeta(item._source),
				state,
				disabledReason,
				shadowedBy: opts?.getShadowedBy?.(item),
				raw: item,
			});
		}
	}

	const loadOpts = cwd
		? { cwd, includeDisabled: true, disabledExtensions: effectiveDisabledIds }
		: { includeDisabled: true, disabledExtensions: effectiveDisabledIds };

	// Load skills
	try {
		const skills = await loadCapability<Skill>("skills", loadOpts);
		addItems(skills.all, "skill", {
			getDescription: s => s.frontmatter?.description,
			getTrigger: s => s.frontmatter?.globs?.join(", "),
		});
	} catch (error) {
		logger.warn("Failed to load skills capability", { error: String(error) });
	}

	// Load rules
	try {
		const rules = await loadCapability<Rule>("rules", loadOpts);
		addItems(rules.all, "rule", {
			getDescription: r => r.description,
			getTrigger: r => r.globs?.join(", ") || (r.alwaysApply ? "always" : undefined),
		});
	} catch (error) {
		logger.warn("Failed to load rules capability", { error: String(error) });
	}

	// Load custom tools
	try {
		const tools = await loadCapability<CustomTool>("tools", loadOpts);
		addItems(tools.all, "tool", {
			getDescription: t => t.description,
		});
	} catch (error) {
		logger.warn("Failed to load tools capability", { error: String(error) });
	}

	// Load extension modules
	try {
		const modules = await loadCapability<ExtensionModule>("extension-modules", loadOpts);
		const nativeModules = modules.all.filter(module => module._source.provider === "native");
		addItems(nativeModules, "extension-module");
	} catch (error) {
		logger.warn("Failed to load extension-modules capability", { error: String(error) });
	}

	// Load MCP servers. The dashboard mirrors `/mcp list` (issue #3827) by
	// honoring the same disable signals: the dashboard-private settings list,
	// the per-server `enabled: false` flag, and the user-level `disabledServers`
	// denylist that `/mcp disable` writes through `setServerDisabled`. The
	// user-level `enabledServers` allowlist overrides a non-writable source's
	// `enabled: false` (e.g. opencode.json) but never the denylist.
	try {
		const userMcpPath = cwd ? getMCPConfigPath("user", cwd) : undefined;
		const [mcpDisabledNames, mcpForcedEnabled] = await Promise.all([
			userMcpPath
				? readDisabledServers(userMcpPath)
						.then(list => new Set(list))
						.catch(() => new Set<string>())
				: Promise.resolve(new Set<string>()),
			userMcpPath
				? readEnabledServers(userMcpPath)
						.then(list => new Set(list))
						.catch(() => new Set<string>())
				: Promise.resolve(new Set<string>()),
		]);
		const mcps = await loadCapability<MCPServer>("mcps", loadOpts);
		for (const server of mcps.all) {
			const id = makeExtensionId("mcp", server.name);
			const forced = mcpForcedEnabled.has(server.name);
			const sourceSaysDisabled = server.enabled === false && !forced;
			const isDisabled = mcpDisabledNames.has(server.name) || disabledExtensions.has(id) || sourceSaysDisabled;
			const { state, disabledReason } = resolveState(
				server._source,
				isDisabled,
				(server as { _shadowed?: boolean })._shadowed,
			);

			extensions.push({
				id,
				kind: "mcp",
				name: server.name,
				displayName: server.name,
				// Config command/url is plumbing, not a description. Live
				// identity comes from serverInfo at inspector render time.
				description: undefined,
				trigger: inferMcpTransport(server),
				path: server._source.path,
				source: sourceFromMeta(server._source),
				state,
				disabledReason,
				raw: server,
			});
		}
	} catch (error) {
		logger.warn("Failed to load mcps capability", { error: String(error) });
	}

	// Load prompts
	try {
		const prompts = await loadCapability<Prompt>("prompts", loadOpts);
		addItems(prompts.all, "prompt", {
			getDescription: () => undefined,
			getTrigger: p => `/prompts:${p.name}`,
		});
	} catch (error) {
		logger.warn("Failed to load prompts capability", { error: String(error) });
	}

	// Load slash commands
	try {
		const commands = await loadCapability<SlashCommand>("slash-commands", loadOpts);
		addItems(commands.all, "slash-command", {
			getDescription: c => {
				const preserved = typeof c.description === "string" ? c.description.trim() : "";
				return preserved.length > 0 ? preserved : commandPreview(c.content).description;
			},
			getTrigger: c => `/${c.name}`,
		});
	} catch (error) {
		logger.warn("Failed to load slash-commands capability", { error: String(error) });
	}

	// Load hooks
	try {
		const hooks = await loadCapability<Hook>("hooks", loadOpts);
		for (const hook of hooks.all) {
			const id = makeExtensionId("hook", `${hook.type}:${hook.tool}:${hook.name}`);
			const { state, disabledReason } = resolveState(
				hook._source,
				disabledExtensions.has(id),
				(hook as { _shadowed?: boolean })._shadowed,
			);

			extensions.push({
				id,
				kind: "hook",
				name: hook.name,
				displayName: hook.name,
				description: `${hook.type}-${hook.tool}`,
				trigger: `${hook.type}:${hook.tool}`,
				path: hook.path,
				source: sourceFromMeta(hook._source),
				state,
				disabledReason,
				raw: hook,
			});
		}
	} catch (error) {
		logger.warn("Failed to load hooks capability", { error: String(error) });
	}

	// Load context files
	try {
		const contextFiles = await loadCapability<ContextFile>("context-files", loadOpts);
		for (const file of contextFiles.all) {
			// Extract filename from path for display
			const name = path.basename(file.path);
			const id = makeExtensionId("context-file", `${file.level}:${name}`);
			const { state, disabledReason } = resolveState(
				file._source,
				disabledExtensions.has(id),
				(file as { _shadowed?: boolean })._shadowed,
			);

			extensions.push({
				id,
				kind: "context-file",
				name,
				displayName: name,
				description: file.level === "user" ? "User-level context" : "Project-level context",
				path: file.path,
				source: sourceFromMeta(file._source),
				state,
				disabledReason,
				raw: file,
			});
		}
	} catch (error) {
		logger.warn("Failed to load context-files capability", { error: String(error) });
	}

	return extensions;
}

/**
 * Toggle provider enabled state.
 */
export function toggleProvider(providerId: string): boolean {
	if (isProviderEnabled(providerId)) {
		disableProvider(providerId);
		return false;
	} else {
		enableProvider(providerId);
		return true;
	}
}

/**
 * Toggle a foreign provider's `~/` config opt-in.
 */
export function toggleUserSource(providerId: string): boolean {
	if (isUserSourceEnabled(providerId)) {
		disableUserSource(providerId);
		return false;
	}
	enableUserSource(providerId);
	return true;
}
