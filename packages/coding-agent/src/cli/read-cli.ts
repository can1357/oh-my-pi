/**
 * Read CLI command handler.
 *
 * Handles `omp read` — invokes the `read` agent tool against a path/URL and
 * prints the resulting content blocks exactly as the model would receive them
 * (including truncation/limit notices appended by the meta-notice wrapper).
 */
import { getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { initializeWithSettings } from "../discovery";
import { closeAllIdaDatabases } from "../ida";
import { loadSkills } from "../extensibility/skills";
import { extractUriScheme } from "../internal-urls/parse";
import { InternalUrlRouter } from "../internal-urls/router";
import { closeDaemonClients } from "../launch/client";
import { discoverAndLoadMCPTools } from "../mcp/loader";
import { MCPManager } from "../mcp/manager";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import type { AuthStorage } from "../session/auth-storage";
import type { ToolSession } from "../tools";
import { wrapToolWithMetaNotice } from "../tools/output-meta";
import { ReadTool, splitImageQuestionTarget } from "../tools/read";
import { renderError } from "../tools/tool-errors";

import { cfgDisabledExtensions, cfgExtensions, cfgSkills } from "../extensibility/settings";
import { cfgMcpEnableProjectConfig } from "../mcp/settings";

export interface ReadCommandArgs {
	path: string;
}

/**
 * Session state `omp read <path>` must load before resolving: the caller's
 * skills for skill:// and MCP servers for MCP resources — `mcp://` or any
 * scheme with no registered handler that the router's MCP fallback accepts.
 * Filesystem paths, web URLs, and other registered schemes need neither.
 */
function readPrerequisites(input: string): { skills: boolean; mcp: boolean } {
	const router = InternalUrlRouter.instance();
	const scheme = extractUriScheme(input);
	if (!scheme || !router.canResolve(input)) return { skills: false, mcp: false };
	return { skills: scheme === "skill", mcp: scheme === "mcp" || router.getHandler(scheme) === undefined };
}

export async function runReadCommand(cmd: ReadCommandArgs): Promise<void> {
	if (!cmd.path) {
		process.stderr.write(chalk.red("error: path is required\n"));
		process.exit(1);
	}

	const cwd = getProjectDir();
	const settings = await Settings.init({ cwd });
	// Capability providers (skills, MCP servers, SSH hosts) honor this session's provider switches.
	initializeWithSettings(settings);

	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	};

	let authStorage: AuthStorage | undefined;
	let mcpManager: MCPManager | undefined;
	let failed = false;

	try {
		const needs = readPrerequisites(cmd.path);
		if (needs.skills) {
			const discovered = await loadSkills({
				...cfgSkills.get(settings),
				cwd,
				disabledExtensions: cfgDisabledExtensions.get(settings),
				extensionRoots: {
					explicit: [],
					mode: "merge",
					configured: cfgExtensions.get(settings),
					configuredLevel: settings.extensionsSourceLevel(),
				},
			});
			session.skills = discovered.skills;
		}

		if (needs.mcp) {
			authStorage = await discoverAuthStorage(undefined, { settings });
			const result = await discoverAndLoadMCPTools(cwd, {
				enableProjectConfig: cfgMcpEnableProjectConfig.get(settings),
				filterExa: true,
				// `omp read` has no Eval prelude, so browser MCP remains available.
				filterBrowser: false,
				cacheStorage: settings.getStorage(),
				authStorage,
			});
			mcpManager = result.manager;
			session.mcpManager = mcpManager;
			MCPManager.setInstance(mcpManager);
		}

		// `read <image>?q=<question>` delegates to a vision model, which needs a
		// model registry to resolve modelRoles.vision / @default and fetch its
		// credentials. The lightweight session above omits it (plain reads never
		// touch a model), so build one on demand — otherwise the tool aborts with
		// "Model registry is unavailable for image questions." before resolving
		// anything (issue #11338).
		if (splitImageQuestionTarget(cmd.path).question) {
			authStorage ??= await discoverAuthStorage(undefined, { settings });
			const modelRegistry = new ModelRegistry(authStorage);
			await modelRegistry.hydrateCredentialScopedModelCaches();
			await loadCliExtensionProviders(modelRegistry, settings, cwd);
			session.modelRegistry = modelRegistry;
		}

		const tool = wrapToolWithMetaNotice(new ReadTool(session));
		const result = await tool.execute("omp-read", { path: cmd.path });

		for (const block of result.content) {
			if (block.type === "text") {
				process.stdout.write(block.text);
				if (!block.text.endsWith("\n")) process.stdout.write("\n");
			} else if (block.type === "image") {
				const decodedBytes = Buffer.from(block.data, "base64").byteLength;
				process.stdout.write(
					chalk.dim(`[image content: ${block.mimeType}, ${decodedBytes} bytes base64-decoded]\n`),
				);
			}
		}
	} catch (err) {
		process.stderr.write(`${chalk.red(renderError(err))}\n`);
		failed = true;
	} finally {
		if (mcpManager) {
			await mcpManager.disconnectAll();
			if (MCPManager.instance() === mcpManager) MCPManager.setInstance(undefined);
		}
		authStorage?.close();
		await closeDaemonClients();
		// Worker processes spawned for executable views keep the event loop alive.
		await closeAllIdaDatabases();
	}

	if (failed) process.exit(1);
}
