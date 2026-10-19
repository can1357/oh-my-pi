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
import { releaseIdaDatabases } from "../ida";
import { loadSkills } from "../extensibility/skills";
import { closeDaemonClients } from "../launch/client";
import { discoverAndLoadMCPTools } from "../mcp/loader";
import { MCPManager } from "../mcp/manager";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import type { AuthStorage } from "../session/auth-storage";
import type { ToolSession } from "../tools";
import { parseReadUrlTarget } from "../tools/fetch";
import { wrapToolWithMetaNotice } from "../tools/output-meta";
import { ReadTool, splitImageQuestionTarget } from "../tools/read";
import { renderError } from "../tools/tool-errors";
import { parseXUrl } from "../web/x";

import { cfgDisabledExtensions, cfgExtensions, cfgSkills } from "../extensibility/settings";
import { cfgMcpEnableProjectConfig } from "../mcp/settings";

export interface ReadCommandArgs {
	path: string;
}

/**
 * `read` may split the input into list entries (`;`, `,`, whitespace) and read each one, so the
 * caller's skills load whenever any entry could be a skill:// URL. Loading them is local and cheap.
 */
const SKILL_URL_RE = /skill:\/\//i;

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
		if (SKILL_URL_RE.test(cmd.path)) {
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

		// MCP servers start only when a read reaches an MCP resource — `mcp://`, a scheme with no
		// registered handler, or a skill:// URL no loaded skill owns — in any list entry.
		MCPManager.setDeferredInstance(async () => {
			authStorage ??= await discoverAuthStorage(undefined, { settings });
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
			return mcpManager;
		});

		// `read <image>?q=<question>` delegates to a vision model, and X URLs read
		// through Grok's X tools; both need a model registry to resolve models and
		// fetch credentials. The lightweight session above omits it (other reads
		// never touch a model), so build one on demand — otherwise image questions
		// abort with "Model registry is unavailable for image questions." before
		// resolving anything (issue #11338), and X reads report missing xAI
		// credentials.
		const urlTarget = parseReadUrlTarget(cmd.path);
		if (splitImageQuestionTarget(cmd.path).question || (urlTarget && parseXUrl(urlTarget.path))) {
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
		MCPManager.setDeferredInstance(undefined);
		if (mcpManager) {
			await mcpManager.disconnectAll();
			if (MCPManager.instance() === mcpManager) MCPManager.setInstance(undefined);
		}
		authStorage?.close();
		// Saves unsaved IDA changes and drops the host sockets that would keep the event loop alive.
		await releaseIdaDatabases();
		await closeDaemonClients();
	}

	if (failed) process.exit(1);
}
