/**
 * MCP Command Controller
 *
 * Handles /mcp subcommands for managing MCP servers.
 */
import { signal } from "@oh-my-pi/pi-tui";
import { getMCPConfigPath, getProjectDir } from "@oh-my-pi/pi-utils";
import { actionKey, formatKeyHint } from "../../ui/keys/hints";
import type { SourceMeta } from "../../capability/types";
import {
	analyzeAuthError,
	discoverOAuthEndpoints,
	fetchResourceMetadataScopes,
	loadAllMCPConfigs,
	MCPManager,
	OAuthIssuerMismatchError,
	reconnectMCPServers,
	resolveMCPTransformContext,
} from "../../mcp";
import {
	findMcpServerForAuth,
	MCPOAuthCancelledError,
	persistMcpOAuthResult,
	probeMcpConnection,
	raceAbortSignal,
	reauthorizeMcpServer,
	runMcpOAuthFlow,
	stripMcpOAuthAuth,
	withTimeout,
	type McpOAuthFlowPresentation,
	type OAuthFlowResult,
} from "../../mcp/oauth-reauth";
import { connectToServer, disconnectServer, listTools } from "../../mcp/client";
import type { McpUpstreamStatus } from "../../mcp/host/contract";
import {
	addMCPServer,
	readDisabledServers,
	readMCPConfigFile,
	removeMCPServer,
	setServerDisabled,
	setServerForceEnabled,
	updateMCPServer,
	validateServerName,
} from "../../mcp/config-writer";
import {
	mcpOAuthCredentialIdsForServerUrl,
	removeManagedMcpOAuthCredential,
	removeManagedMcpOAuthCredentials,
} from "../../mcp/oauth-credentials";
import type { MCPAuthChallenge, MCPConfigFile, MCPServerConfig, MCPServerConnection } from "../../mcp/types";
import { shortenPath } from "../../utils/render-utils";
import { copyToClipboard } from "../../utils/clipboard";
import { openPath } from "../../utils/open";
import { MCPAddWizard } from "../../ui/overlays/panels/mcp-add-wizard";
import { MCPAddWizardModel } from "../../ui/overlays/panels/mcp-add-wizard-model";
import { findNode } from "../../ui/styles/panels/common";
import { reportTextView } from "./command-views";
import { parseCommandArgs } from "../../utils/command-args";
import type { InteractiveModeContext } from "../types";
import { groupBySource, parseRemoveArgs, readScopeFlag, showCommandMessage } from "./command-controller-shared";
import { mcpConnectingBlock, mcpNoteBlock, mcpOAuthBlock, mcpTestHintBlock } from "./mcp-blocks";

import { cfgMcpEnableProjectConfig } from "../../mcp/settings";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const MCP_MANUAL_INPUT_PROVIDER_ID = "mcp";
const MCP_TEST_ESCAPE_GRACE_MS = 5_000;

/** Host-side state of a server for the `/mcp` list: upstream state, pid, and how many sessions share it. */
function describeServerRuntime(runtime: McpUpstreamStatus | undefined): string {
	if (!runtime) return "";
	const parts = [
		runtime.state === "running" && runtime.pid !== undefined ? `running, pid ${runtime.pid}` : runtime.state,
	];
	if (runtime.links > 1) parts.push(`shared by ${runtime.links} sessions`);
	return parts.join(", ");
}

/** Reason recorded on the OAuth flow's AbortController when the user hits Esc. */
const MCP_OAUTH_USER_CANCEL_REASON = "MCP OAuth flow cancelled by user";

type MCPAddScope = "user" | "project";
type MCPAddTransport = "http" | "sse";

type MCPAddParsed = {
	initialName?: string;
	scope: MCPAddScope;
	quickConfig?: MCPServerConfig;
	isCommandQuickAdd?: boolean;
	hasAuthToken?: boolean;
	error?: string;
};

/**
 * Collect the de-duplicated union of every MCP server name we know about:
 * user config, project config, and any runtime-discovered servers not
 * already present in either config (`ctx.mcpManager.getAllServerNames()`
 * covers connections, pending connections, and discovered-but-not-yet-
 * connected sources).
 *
 * `includeDisabledOnly` controls names found only in
 * `userConfig.disabledServers`, while `includeDisabledConfigured` controls
 * config entries whose `enabled` flag is false. Both default to true because
 * callers such as `/mcp list` need the complete union. Autocomplete callers
 * must disable the categories their target operation cannot accept.
 *
 * This is the single source of truth for "every known server name": both
 * `MCPCommandController#handleList()` and the `/mcp` slash-command argument
 * completer (server-name autocomplete for `enable`/`disable`/`test`/etc.)
 * call this instead of re-deriving the union themselves.
 *
 * `preloaded` lets a caller that already read both config files (e.g.
 * `#handleList()`) pass them in and skip the redundant re-read.
 */
export async function collectMcpServerNames(
	ctx: InteractiveModeContext,
	preloaded?: { userConfig: MCPConfigFile; projectConfig: MCPConfigFile },
	includeDisabledOnly = true,
	includeDisabledConfigured = true,
): Promise<string[]> {
	let userConfig: MCPConfigFile;
	let projectConfig: MCPConfigFile;
	if (preloaded) {
		({ userConfig, projectConfig } = preloaded);
	} else {
		const cwd = getProjectDir();
		[userConfig, projectConfig] = await Promise.all([
			readMCPConfigFile(getMCPConfigPath("user", cwd)),
			readMCPConfigFile(getMCPConfigPath("project", cwd)),
		]);
	}

	const names = new Set<string>(includeDisabledOnly ? (userConfig.disabledServers ?? []) : []);
	const addConfiguredNames = (config: MCPConfigFile): void => {
		const servers = config.mcpServers;
		if (!servers) return;
		for (const name in servers) {
			const server = servers[name];
			if (server && (includeDisabledConfigured || server.enabled !== false)) names.add(name);
		}
	};
	addConfiguredNames(userConfig);
	addConfiguredNames(projectConfig);
	if (ctx.mcpManager) {
		for (const name of ctx.mcpManager.getAllServerNames()) {
			names.add(name);
		}
		// Dropped by a built-in transform: not running, so only what accepts a
		// disabled server can act on them.
		if (includeDisabledOnly) {
			for (const name of ctx.mcpManager.getBuiltinDrops().keys()) names.add(name);
		}
	}
	return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export class MCPCommandController {
	constructor(private ctx: InteractiveModeContext) {}

	/**
	 * Handle /mcp command and route to subcommands
	 */
	async handle(text: string): Promise<void> {
		const parts = parseCommandArgs(text.trim());
		const subcommand = parts[1]?.toLowerCase();
		const serverName = parts.slice(2).join(" ") || undefined;

		if (!subcommand || subcommand === "help") {
			this.#showHelp();
			return;
		}

		switch (subcommand) {
			case "add":
				await this.#handleAdd(text);
				break;
			case "list":
				await this.#handleList();
				break;
			case "remove":
			case "rm":
				await this.#handleRemove(text);
				break;
			case "test":
				await this.#handleTest(serverName);
				break;
			case "reauth":
				await this.#handleReauth(serverName);
				break;
			case "unauth":
				await this.#handleUnauth(serverName);
				break;
			case "enable":
				await this.#handleSetEnabled(serverName, true);
				break;
			case "disable":
				await this.#handleSetEnabled(serverName, false);
				break;
			case "resources":
				await this.#handleResources();
				break;
			case "prompts":
				await this.#handlePrompts();
				break;
			case "notifications":
				await this.#handleNotifications();
				break;
			case "reconnect":
				await this.#handleReconnect(serverName);
				break;
			case "reload":
				await this.#handleReload();
				break;
			default:
				this.ctx.showError(`Unknown subcommand: ${subcommand}. Type /mcp help for usage.`);
		}
	}

	/**
	 * Show help text
	 */
	#showHelp(): void {
		const helpText = [
			"Manage Model Context Protocol (MCP) servers for external tool integrations.",
			"",
			currentTheme().fg("accent", "Commands:"),
			"  /mcp add              Add a new MCP server (interactive wizard)",
			"  /mcp add <name> [--scope project|user] [--url <url> --transport http|sse] [--token <token>] [-- <command...>]",
			"  /mcp list             List all configured MCP servers",
			"  /mcp remove <name> [--scope project|user]    Remove an MCP server (default: project)",
			"  /mcp test <name>      Test connection to an MCP server",
			"  /mcp reauth <name>    Reauthorize OAuth for an MCP server",
			"  /mcp unauth <name>    Remove OAuth auth from an MCP server",
			"  /mcp enable <name>    Enable an MCP server",
			"  /mcp disable <name>   Disable an MCP server",
			"  /mcp reconnect <name> Reconnect to a specific MCP server",
			"  /mcp reload           Force reload and rediscover MCP runtime tools",
			"  /mcp resources        List available resources from connected servers",
			"  /mcp prompts          List available prompts from connected servers",
			"  /mcp notifications    Show notification capabilities and subscription state",
			"  /mcp help             Show this help message",
			"",
		].join("\n");

		this.#showReport("MCP Server Management", helpText);
	}

	#parseAddCommand(text: string): MCPAddParsed {
		const prefixMatch = text.match(/^\/mcp\s+add\b\s*(.*)$/i);
		const rest = prefixMatch?.[1]?.trim() ?? "";
		if (!rest) {
			return { scope: "project" };
		}

		const tokens = parseCommandArgs(rest);
		if (tokens.length === 0) {
			return { scope: "project" };
		}

		let name: string | undefined;
		let scope: MCPAddScope = "project";
		let url: string | undefined;
		let transport: MCPAddTransport = "http";
		let authToken: string | undefined;
		let commandTokens: string[] | undefined;

		let i = 0;
		if (!tokens[0].startsWith("-")) {
			name = tokens[0];
			i = 1;
		}

		while (i < tokens.length) {
			const argToken = tokens[i];
			if (argToken === "--") {
				commandTokens = tokens.slice(i + 1);
				break;
			}
			if (argToken === "--scope") {
				const r = readScopeFlag(tokens[i + 1]);
				if (!r.ok) {
					return { scope, error: r.error };
				}
				scope = r.scope;
				i += 2;
				continue;
			}
			if (argToken === "--url") {
				const value = tokens[i + 1];
				if (!value) {
					return { scope, error: "Missing value for --url." };
				}
				url = value;
				i += 2;
				continue;
			}
			if (argToken === "--transport") {
				const value = tokens[i + 1];
				if (!value || (value !== "http" && value !== "sse")) {
					return { scope, error: "Invalid --transport value. Use http or sse." };
				}
				transport = value;
				i += 2;
				continue;
			}
			if (argToken === "--token") {
				const value = tokens[i + 1];
				if (!value) {
					return { scope, error: "Missing value for --token." };
				}
				authToken = value;
				i += 2;
				continue;
			}
			return { scope, error: `Unknown option: ${argToken}` };
		}

		const hasQuick = Boolean(url) || Boolean(commandTokens && commandTokens.length > 0);
		if (!hasQuick) {
			return { scope, initialName: name };
		}
		if (!name) {
			return { scope, error: "Server name required for quick add. Usage: /mcp add <name> ..." };
		}
		if (url && commandTokens && commandTokens.length > 0) {
			return { scope, error: "Use either --url or -- <command...>, not both." };
		}
		if (authToken && !url) {
			return { scope, error: "--token requires --url (HTTP/SSE transport)." };
		}

		if (commandTokens && commandTokens.length > 0) {
			const [command, ...args] = commandTokens;
			const config: MCPServerConfig = {
				type: "stdio",
				command,
				args: args.length > 0 ? args : undefined,
			};
			return { scope, initialName: name, quickConfig: config, isCommandQuickAdd: true };
		}

		const useHttpTransport = transport === "http";
		let normalizedUrl = url!;
		if (!/^https?:\/\//i.test(normalizedUrl)) {
			normalizedUrl = `https://${normalizedUrl}`;
		}
		const config: MCPServerConfig = {
			type: useHttpTransport ? "http" : "sse",
			url: normalizedUrl,
			headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
		};
		return {
			scope,
			initialName: name,
			quickConfig: config,
			isCommandQuickAdd: false,
			hasAuthToken: Boolean(authToken),
		};
	}

	/**
	 * Handle /mcp add - Launch interactive wizard or quick-add from args
	 */
	async #handleAdd(text: string): Promise<void> {
		const parsed = this.#parseAddCommand(text);
		if (parsed.error) {
			this.ctx.showError(parsed.error);
			return;
		}
		if (parsed.quickConfig && parsed.initialName) {
			let finalConfig = parsed.quickConfig;

			// Quick-add with URL should still perform auth detection and OAuth flow,
			// matching wizard behavior. Command quick-add intentionally skips this.
			if (!parsed.isCommandQuickAdd && (finalConfig.type === "http" || finalConfig.type === "sse")) {
				try {
					await this.#handleTestConnection(finalConfig);
				} catch (error) {
					if (parsed.hasAuthToken) {
						this.ctx.showError(
							`Authentication failed for "${parsed.initialName}": ${error instanceof Error ? error.message : String(error)}`,
						);
						return;
					}
					const authResult = analyzeAuthError(error as Error, finalConfig.url);
					if (authResult.requiresAuth) {
						let oauth = authResult.authType === "oauth" ? (authResult.oauth ?? null) : null;
						if (!oauth && finalConfig.url) {
							try {
								oauth = await discoverOAuthEndpoints(
									finalConfig.url,
									authResult.authServerUrl,
									authResult.resourceMetadataUrl,
									{ protectedScopes: authResult.scopes },
								);
							} catch (discoveryError) {
								// Name a misconfigured advertised server; other failures fall through below.
								if (discoveryError instanceof OAuthIssuerMismatchError) {
									this.ctx.showError(
										`Authentication required for "${parsed.initialName}": ${discoveryError.message}`,
									);
									return;
								}
							}
						}
						if (oauth && !oauth.scopes && authResult.resourceMetadataUrl) {
							// JSON-error-body path skips `discoverOAuthEndpoints`; fetch the
							// advertised protected-resource metadata for the required scopes.
							const scopes = await fetchResourceMetadataScopes(authResult.resourceMetadataUrl);
							if (scopes) oauth = { ...oauth, scopes };
						}

						if (!oauth) {
							this.ctx.showError(
								`Authentication required for "${parsed.initialName}", but OAuth endpoints could not be discovered. ` +
									`Use /mcp add ${parsed.initialName} (wizard) or configure auth manually.`,
							);
							return;
						}

						try {
							const oauthResource = oauth.resource ?? finalConfig.url;
							const oauthResourceIsFallback = !oauth.resource;
							const oauthResult = await this.#handleOAuthFlow(
								oauth.authorizationUrl,
								oauth.tokenUrl,
								oauth.clientId ?? finalConfig.oauth?.clientId ?? "",
								finalConfig.oauth?.clientSecret ?? "",
								oauth.scopes ?? "",
								{
									callbackPort: finalConfig.oauth?.callbackPort,
									callbackPath: finalConfig.oauth?.callbackPath,
									redirectUri: finalConfig.oauth?.redirectUri,
									prompt: finalConfig.oauth?.prompt,
									registrationUrl: oauth.registrationUrl,
									issuerUrl: oauth.issuerUrl,
									serverUrl: finalConfig.url,
									resource: oauthResource,
									stripSameOriginResource: oauthResourceIsFallback,
								},
							);
							finalConfig = persistMcpOAuthResult(finalConfig, oauthResult, {
								tokenUrl: oauth.tokenUrl,
								resource: oauthResource,
								stripSameOriginResource: oauthResourceIsFallback,
								clientId: oauth.clientId,
								userClientSecret: finalConfig.oauth?.clientSecret,
							});
						} catch (oauthError) {
							if (oauthError instanceof MCPOAuthCancelledError) {
								this.ctx.showStatus(`Add cancelled for "${parsed.initialName}"`);
								return;
							}
							this.ctx.showError(
								`OAuth flow failed for "${parsed.initialName}": ${oauthError instanceof Error ? oauthError.message : String(oauthError)}`,
							);
							return;
						}
					}
				}
			}

			await this.#handleWizardComplete(parsed.initialName, finalConfig, parsed.scope);
			return;
		}

		const model = new MCPAddWizardModel(
			{ validateServerName, analyzeAuthError, discoverOAuthEndpoints, fetchResourceMetadataScopes },
			{
				onComplete: (name, config, scope) => {
					wizard.close();
					void this.#handleWizardComplete(name, config, scope);
				},
				onCancel: () => {
					wizard.close();
					this.#handleWizardCancel();
				},
				onOAuth: (authUrl, tokenUrl, clientId, clientSecret, scopes, options) =>
					this.#handleOAuthFlow(authUrl, tokenUrl, clientId, clientSecret, scopes, options),
				onTestConnection: config => this.#handleTestConnection(config),
			},
			{ theme: currentTheme },
			{ initialName: parsed.initialName },
		);
		// The wizard takes the composer's place until it completes or is cancelled.
		this.ctx.closeLinkBrowser();
		const wizard = this.ctx.showEditorAreaDialog(() => MCPAddWizard({ model }), {
			focus: root => findNode(root, node => node.kind === "picker" || node.kind === "list") ?? root,
		});
	}

	/**
	 * Handle OAuth authentication flow for MCP server. Thin TUI wrapper over
	 * the shared engine (`runMcpOAuthFlow` in `mcp/oauth-reauth.ts`): supplies
	 * the transcript-block presentation, clipboard staging, manual code input
	 * claim, and the editor Esc hook, then leaves flow semantics to the engine.
	 */
	async #handleOAuthFlow(
		authUrl: string,
		tokenUrl: string,
		clientId: string,
		clientSecret: string,
		scopes: string,
		opts?: {
			callbackPort?: number;
			callbackPath?: string;
			redirectUri?: string;
			prompt?: string;
			serverUrl?: string;
			registrationUrl?: string;
			issuerUrl?: string;
			resource?: string;
			stripSameOriginResource?: boolean;
			/**
			 * External cancellation source: when this signal aborts, the in-flight
			 * OAuth flow is torn down and {@link MCPOAuthCancelledError} is thrown.
			 * Wizards (which own focus and absorb Esc themselves) pass their own
			 * controller here; editor-focused callers rely on the Esc hook
			 * installed below instead.
			 */
			abortSignal?: AbortSignal;
		},
	): Promise<OAuthFlowResult> {
		const { callbacks, release } = this.#oauthFlowCallbacks();
		try {
			return await this.#withOAuthEscape((escapeSignal, onClaimed) =>
				runMcpOAuthFlow({
					authUrl,
					tokenUrl,
					clientId,
					clientSecret,
					scopes,
					serverUrl: opts?.serverUrl,
					registrationUrl: opts?.registrationUrl,
					issuerUrl: opts?.issuerUrl,
					resource: opts?.resource,
					stripSameOriginResource: opts?.stripSameOriginResource,
					callbackPort: opts?.callbackPort,
					callbackPath: opts?.callbackPath,
					redirectUri: opts?.redirectUri,
					prompt: opts?.prompt,
					authStorage: this.ctx.session.modelRegistry.authStorage,
					signal: opts?.abortSignal ? AbortSignal.any([escapeSignal, opts.abortSignal]) : escapeSignal,
					flowOwner: this.ctx.oauthManualInput,
					pendingInput: () =>
						this.ctx.oauthManualInput.hasPending()
							? (this.ctx.oauthManualInput.pendingProviderId ?? "another provider")
							: undefined,
					onClaimed,
					...callbacks,
				}),
			);
		} finally {
			release();
		}
	}

	/**
	 * TUI presentation for the shared MCP OAuth engine. The manual-input claim
	 * taken for fallback code input is released by the returned `release` when
	 * the flow settles, mirroring the engine's own single-flight release.
	 */
	#oauthFlowCallbacks(): { callbacks: McpOAuthFlowPresentation; release: () => void } {
		const manualInput = this.ctx.oauthManualInput;
		let manualInputClaim: { promise: Promise<string>; clear: (reason?: string) => void } | undefined;
		let manualInputReleased = false;
		// Idempotent: the engine releases the manual claim in its `finally`
		// (before the single-flight release, so a superseding flow observes no
		// pending manual input), and the controller `finally` calls it again.
		const releaseManualInput = (): void => {
			if (manualInputReleased) return;
			manualInputReleased = true;
			manualInputClaim?.clear("Manual MCP OAuth input cleared");
		};
		return {
			callbacks: {
				onAuth: info => {
					// Show auth URL prominently in chat as one block.
					// `openPath` is best-effort — it logs spawn failures but never
					// throws, so the copy-URL fallback always shows beneath the
					// "attempting to open browser" line.
					openPath(info.url);
					// Stage the FULL authorization URL on the clipboard via OSC 52.
					// The full URL works from any machine (unlike `launchUrl`, which
					// only resolves against the OMP host), and OSC 52 is a
					// wire-level protocol — the terminal writes it to the user's
					// LOCAL clipboard even when OMP is on a remote SSH box.
					// Best-effort: the visible copy-URL rows remain the fallback
					// whether or not the terminal honors OSC 52.
					void copyToClipboard(info.url).catch(() => {});
					const interruptKey = actionKey("app.interrupt", this.ctx.keybindings);
					this.ctx.present(() => mcpOAuthBlock({ url: info.url, launchUrl: info.launchUrl, interruptKey }));
				},
				onProgress: message => {
					this.ctx.present(() => mcpNoteBlock("muted", message));
				},
				onFlowComplete: () => {
					this.ctx.present(() => mcpNoteBlock("success", "✓ Authorization completed in browser."));
				},
				onManualCodeInput: signal => {
					if (manualInputClaim) return manualInputClaim.promise;
					const pendingInput = manualInput.tryClaimInput(MCP_MANUAL_INPUT_PROVIDER_ID);
					if (!pendingInput) {
						const pendingProvider = manualInput.pendingProviderId ?? "another provider";
						throw new Error(
							`OAuth login already in progress for ${pendingProvider}. Complete or cancel it before starting MCP OAuth.`,
						);
					}
					const onAbort = () => pendingInput.clear("Manual MCP OAuth input cancelled");
					if (signal?.aborted) onAbort();
					else signal?.addEventListener("abort", onAbort, { once: true });
					const claim = {
						clear: pendingInput.clear,
						promise: pendingInput.promise.finally(() => {
							signal?.removeEventListener("abort", onAbort);
							if (manualInputClaim === claim) manualInputClaim = undefined;
						}),
					};
					manualInputClaim = claim;
					return claim.promise;
				},
				releaseManualInput,
			},
			release: releaseManualInput,
		};
	}

	/**
	 * Claim the interrupt key (Esc) in the composer for the duration of an MCP OAuth flow: it
	 * aborts the supplied signal, which the shared engine races and reclassifies as a neutral
	 * {@link MCPOAuthCancelledError}.
	 *
	 * The claim starts when the flow's single-flight claim resolves (via the engine's
	 * `onClaimed`), not when the flow starts: a flow superseded while queued never claims, so it
	 * holds nothing. Claims stack newest first, so overlapping flows unwind in any order and the
	 * key returns to its default (interrupt, cancel compaction) once the last one settles. A
	 * wizard holding the keys absorbs Esc itself, so only the composer's Esc counts.
	 */
	#withOAuthEscape<T>(run: (escapeSignal: AbortSignal, onClaimed: () => void) => Promise<T>): Promise<T> {
		const escape = new AbortController();
		let release: (() => void) | undefined;
		const onClaimed = (): void => {
			release ??= this.ctx.interceptInput(event => {
				if (event.type !== "key" || this.ctx.shell.focused() !== this.ctx.composer.field) return false;
				if (!this.ctx.keybindings.matches(event.key, "app.interrupt")) return false;
				escape.abort(MCP_OAUTH_USER_CANCEL_REASON);
				return true;
			});
		};
		return run(escape.signal, onClaimed).finally(() => release?.());
	}

	/**
	 * Test connection to an MCP server.
	 * Throws an error if connection fails (used for auto-detection).
	 */
	async #handleTestConnection(config: MCPServerConfig, options?: { oauth?: boolean }): Promise<void> {
		await probeMcpConnection(config, {
			oauth: options?.oauth,
			authStorage: this.ctx.session.modelRegistry.authStorage,
			mcpManager: this.ctx.mcpManager,
		});
	}

	async #waitForServerConnectionWithAnimation(
		name: string,
		options?: { suppressDisconnectedWarning?: boolean },
	): Promise<"connected" | "connecting" | "disconnected"> {
		if (!this.ctx.mcpManager) return "disconnected";

		const status = signal<string | undefined>(undefined);
		const block = this.ctx.present(() => mcpConnectingBlock(name, status), { live: true });

		try {
			try {
				await withTimeout(this.ctx.mcpManager.waitForConnection(name), 10_000, "Connection still pending");
			} catch {
				// Ignore timeout/errors here and use status check below.
			}
			const state = this.ctx.mcpManager.getConnectionStatus(name);
			if (state === "connected") {
				// Connection may complete after initial reload; rebind runtime MCP tools now.
				await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
			}
			if (state === "connected") {
				status.set(
					currentTheme().fg(
						"success",
						`${currentTheme().symbols.symbol("status.enabled")} Connected to "${name}"`,
					),
				);
			} else if (state === "connecting") {
				status.set(currentTheme().fg("muted", `◌ "${name}" is still connecting...`));
			} else {
				status.set(
					options?.suppressDisconnectedWarning
						? currentTheme().fg("muted", `◌ Connection check complete for "${name}"`)
						: currentTheme().fg(
								"warning",
								`${currentTheme().symbols.symbol("status.warning")} Could not connect to "${name}" yet`,
							),
				);
			}
			return state;
		} finally {
			this.ctx.shell.transcript.settle(block);
		}
	}

	async #syncManagerConnection(name: string, config: MCPServerConfig): Promise<void> {
		if (!this.ctx.mcpManager) return;
		if (this.ctx.mcpManager.getConnectionStatus(name) !== "disconnected") return;
		await this.ctx.mcpManager.connectServers({ [name]: config }, {});
		if (this.ctx.mcpManager.getConnectionStatus(name) === "connected") {
			await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
		}
	}

	async #handleWizardComplete(name: string, config: MCPServerConfig, scope: "user" | "project"): Promise<void> {
		try {
			// Determine file path
			const cwd = getProjectDir();
			const filePath = getMCPConfigPath(scope, cwd);

			// Add server to config
			await addMCPServer(filePath, name, config);

			// Reload MCP manager
			await this.reloadServers();
			const state =
				config.enabled === false
					? "disconnected"
					: await this.#waitForServerConnectionWithAnimation(name, { suppressDisconnectedWarning: true });
			let isConnected = state === "connected";
			const isConnecting = state === "connecting";

			// Fallback: if manager state is still disconnected but direct test works,
			// report as connected to avoid false-negative messaging.
			if (!isConnected && !isConnecting && config.enabled !== false) {
				try {
					await this.#handleTestConnection(config);
					isConnected = true;
					await this.#syncManagerConnection(name, config);
				} catch {
					// Keep disconnected status
				}
			}

			// A new server's tools are enabled by refresh; explicitly selecting this
			// server also enables tools that were registered before the wizard ran.
			if (isConnected && this.ctx.mcpManager) {
				const serverTools = this.ctx.mcpManager.getTools().filter(t => t.mcpServerName === name);
				if (serverTools.length > 0) {
					const currentActive = this.ctx.session.getEnabledToolNames();
					const toActivate = serverTools.map(t => t.name).filter(n => this.ctx.session.getToolByName(n));
					if (toActivate.length > 0) {
						await this.ctx.session.setActiveToolsByName([...new Set([...currentActive, ...toActivate])]);
					}
				}
			}

			// Show success message
			const scopeLabel = scope === "user" ? "user" : "project";
			const lines = ["", currentTheme().fg("success", `+ Added server "${name}" to ${scopeLabel} config`), ""];

			if (isConnected) {
				lines.push(
					currentTheme().fg(
						"success",
						`${currentTheme().symbols.symbol("status.enabled")} Successfully connected to server`,
					),
				);
				lines.push("");
			} else if (isConnecting) {
				lines.push(currentTheme().fg("muted", `◌ Server is connecting in background...`));
				lines.push(
					currentTheme().fg(
						"muted",
						`  Run ${currentTheme().fg("accent", `/mcp test ${name}`)} in a few seconds.`,
					),
				);
				lines.push("");
			} else {
				lines.push(
					currentTheme().fg(
						"warning",
						`${currentTheme().symbols.symbol("status.warning")} Server added but not yet connected`,
					),
				);
				lines.push(
					currentTheme().fg(
						"muted",
						`  Run ${currentTheme().fg("accent", `/mcp test ${name}`)} to test the connection.`,
					),
				);
				lines.push("");
			}

			lines.push(
				currentTheme().fg(
					"muted",
					`Run ${currentTheme().fg("accent", "/mcp list")} to see all configured servers.`,
				),
			);
			lines.push("");

			this.#showMessage(lines.join("\n"));
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);

			// Provide helpful error messages
			let helpText = "";
			if (errorMsg.includes("EACCES") || errorMsg.includes("permission denied")) {
				helpText = "\n\nTip: Check file permissions for the config directory.";
			} else if (errorMsg.includes("ENOSPC")) {
				helpText = "\n\nTip: Insufficient disk space.";
			} else if (errorMsg.includes("already exists")) {
				helpText = `\n\nTip: Use ${currentTheme().fg("accent", "/mcp list")} to see existing servers.`;
			}

			this.ctx.showError(`Failed to add server: ${errorMsg}${helpText}`);
		}
	}

	#handleWizardCancel(): void {
		this.#showMessage(
			[
				"",
				currentTheme().fg("muted", "Server creation cancelled."),
				"",
				currentTheme().fg(
					"dim",
					`Tip: Press ${formatKeyHint("ctrl+c")} or ${actionKey("app.interrupt", this.ctx.keybindings)} anytime to cancel`,
				),
				"",
			].join("\n"),
		);
	}

	/**
	 * Handle /mcp list - Show all configured servers
	 */
	async #handleList(): Promise<void> {
		try {
			const cwd = getProjectDir();

			// Load from both user and project configs
			const userPath = getMCPConfigPath("user", cwd);
			const projectPath = getMCPConfigPath("project", cwd);

			const userPathLabel = shortenPath(userPath);
			const projectPathLabel = shortenPath(projectPath);
			const [userConfig, projectConfig] = await Promise.all([
				readMCPConfigFile(userPath),
				readMCPConfigFile(projectPath),
			]);

			const userServers = Object.keys(userConfig.mcpServers ?? {});
			const projectServers = Object.keys(projectConfig.mcpServers ?? {});

			// Collect runtime-discovered servers not in config files
			const configServerNames = new Set([...userServers, ...projectServers]);
			const disabledServerNames = new Set(userConfig.disabledServers ?? []);
			const discoveredServers: { name: string; source: SourceMeta }[] = [];
			if (this.ctx.mcpManager) {
				const allServerNames = await collectMcpServerNames(this.ctx, { userConfig, projectConfig });
				for (const name of allServerNames) {
					if (configServerNames.has(name)) continue;
					if (disabledServerNames.has(name)) continue;
					const source = this.ctx.mcpManager.getSource(name);
					if (source) {
						discoveredServers.push({ name, source });
					}
				}
			}

			const builtinDrops = this.ctx.mcpManager?.getBuiltinDrops();
			if (
				userServers.length === 0 &&
				projectServers.length === 0 &&
				discoveredServers.length === 0 &&
				disabledServerNames.size === 0 &&
				!builtinDrops?.size
			) {
				this.#showReport(
					"MCP Servers",
					[
						currentTheme().fg("muted", "No MCP servers configured."),
						"",
						`Use ${currentTheme().fg("accent", "/mcp add")} to add a server.`,
					].join("\n"),
				);
				return;
			}

			const lines: string[] = [];
			const runtimeOf = (name: string): string => {
				const text = describeServerRuntime(this.ctx.mcpManager?.getServerRuntime(name));
				return text ? currentTheme().fg("dim", ` (${text})`) : "";
			};

			// Show user-level servers
			if (userServers.length > 0) {
				lines.push(currentTheme().fg("accent", "User level") + currentTheme().fg("muted", ` (${userPathLabel}):`));
				for (const name of userServers) {
					const config = userConfig.mcpServers![name];
					const type = config.type ?? "stdio";
					const state =
						config.enabled === false
							? "inactive"
							: (this.ctx.mcpManager?.getConnectionStatus(name) ?? "disconnected");
					const status =
						state === "inactive"
							? currentTheme().fg("warning", " ◌ inactive")
							: state === "connected"
								? currentTheme().fg("success", " ● connected")
								: state === "connecting"
									? currentTheme().fg("muted", " ◌ connecting")
									: currentTheme().fg("muted", " ○ not connected");
					const runtime = state === "inactive" ? "" : runtimeOf(name);
					lines.push(
						`  ${currentTheme().fg("accent", name)}${status}${runtime} ${currentTheme().fg("dim", `[${type}]`)}`,
					);
				}
				lines.push("");
			}

			// Show project-level servers
			if (projectServers.length > 0) {
				lines.push(
					currentTheme().fg("accent", "Project level") + currentTheme().fg("muted", ` (${projectPathLabel}):`),
				);
				for (const name of projectServers) {
					const config = projectConfig.mcpServers![name];
					const type = config.type ?? "stdio";
					const state =
						config.enabled === false
							? "inactive"
							: (this.ctx.mcpManager?.getConnectionStatus(name) ?? "disconnected");
					const status =
						state === "inactive"
							? currentTheme().fg("warning", " ◌ inactive")
							: state === "connected"
								? currentTheme().fg("success", " ● connected")
								: state === "connecting"
									? currentTheme().fg("muted", " ◌ connecting")
									: currentTheme().fg("muted", " ○ not connected");
					const runtime = state === "inactive" ? "" : runtimeOf(name);
					lines.push(
						`  ${currentTheme().fg("accent", name)}${status}${runtime} ${currentTheme().fg("dim", `[${type}]`)}`,
					);
				}
				lines.push("");
			}

			// Show discovered servers (from .claude/.mcp.json, .codex/config.toml, opencode.json, etc.)
			if (discoveredServers.length > 0) {
				for (const { providerName, shortPath, items: entries } of groupBySource(discoveredServers, e => e.source)) {
					lines.push(currentTheme().fg("accent", providerName) + currentTheme().fg("muted", ` (${shortPath}):`));
					for (const { name } of entries) {
						const state = this.ctx.mcpManager!.getConnectionStatus(name);
						const status =
							state === "connected"
								? currentTheme().fg("success", " ● connected")
								: state === "connecting"
									? currentTheme().fg("muted", " ◌ connecting")
									: currentTheme().fg("muted", " ○ not connected");
						lines.push(`  ${currentTheme().fg("accent", name)}${status}${runtimeOf(name)}`);
					}
					lines.push("");
				}
			}

			// Show servers disabled via /mcp disable (from third-party configs)
			const relevantDisabled = [...disabledServerNames].filter(n => !configServerNames.has(n));
			if (relevantDisabled.length > 0) {
				lines.push(currentTheme().fg("accent", "Disabled") + currentTheme().fg("muted", " (discovered servers):"));
				for (const name of relevantDisabled) {
					lines.push(`  ${currentTheme().fg("accent", name)}${currentTheme().fg("warning", " ◌ disabled")}`);
				}
				lines.push("");
			}

			// Show servers a built-in transform left unconnected, with the way back
			if (builtinDrops?.size) {
				lines.push(
					currentTheme().fg("accent", "Replaced by built-ins") +
						currentTheme().fg("muted", " (/mcp enable <name> connects one anyway):"),
				);
				for (const [name, drop] of builtinDrops) {
					const detail = `${drop.reason} (${shortenPath(drop.source.path)})`;
					lines.push(
						`  ${currentTheme().fg("accent", name)}${currentTheme().fg("warning", " ◌ replaced:")} ${currentTheme().fg("dim", detail)}`,
					);
				}
				lines.push("");
			}
			this.#showReport("Configured MCP Servers", lines.join("\n"));
		} catch (error) {
			this.ctx.showError(`Failed to list servers: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Handle /mcp remove <name> - Remove a server
	 */
	async #handleRemove(text: string): Promise<void> {
		const match = text.match(/^\/mcp\s+(?:remove|rm)\b\s*(.*)$/i);
		const rest = match?.[1]?.trim() ?? "";
		const parsed = parseRemoveArgs(rest);
		if (!parsed.ok) {
			this.ctx.showError(parsed.error);
			return;
		}
		const { name, scope } = parsed.value;

		if (!name) {
			this.ctx.showError("Server name required. Usage: /mcp remove <name> [--scope project|user]");
			return;
		}

		try {
			const cwd = getProjectDir();
			const userPath = getMCPConfigPath("user", cwd);
			const projectPath = getMCPConfigPath("project", cwd);
			const filePath = scope === "user" ? userPath : projectPath;
			const config = await readMCPConfigFile(filePath);
			if (!config.mcpServers?.[name]) {
				this.ctx.showError(`Server "${name}" not found in ${scope} config.`);
				return;
			}

			// Disconnect if connected
			if (this.ctx.mcpManager?.getConnection(name)) {
				await this.ctx.mcpManager.disconnectServer(name);
			}

			// Remove from config
			await removeMCPServer(filePath, name);

			// Reload MCP manager
			await this.reloadServers();

			this.#showMessage(
				["", currentTheme().fg("success", `- Removed server "${name}" from ${scope} config`), ""].join("\n"),
			);
		} catch (error) {
			this.ctx.showError(`Failed to remove server: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Handle /mcp test <name> - Test connection to a server
	 */
	async #handleTest(name: string | undefined): Promise<void> {
		if (!name) {
			this.ctx.showError("Server name required. Usage: /mcp test <name>");
			return;
		}

		const abortController = new AbortController();
		let settled = false;
		const handleEscape = (): void => {
			if (settled) {
				this.ctx.showStatus(`MCP test for "${name}" already finished`);
				return;
			}
			abortController.abort();
		};

		// Claim Esc before the first await: a slow `#resolveServerForAuth()` (e.g.
		// config on a network filesystem) must not let Esc fall through to the
		// agent-turn abort while the command is already running.
		this.ctx.mcpTestEscapeHandlers.add(handleEscape);

		let connection: MCPServerConnection | undefined;
		// The grace window only applies once the "(esc to cancel)" hint is on
		// screen; a pre-hint failure must release Esc immediately so it is not
		// swallowed for a prompt the user never saw.
		let hintShown = false;
		const hint = signal("");
		// Outcome-branched settled text: a cancelled or failed test must not
		// read as if it completed.
		let settleNote = `Tested connection to "${name}".`;
		// Cancellation can land while later awaits (auth prepareConfig, connect)
		// are still unwinding. Drop the esc affordance the moment it happens —
		// the dispatcher already consumed the ownership — but claim no outcome:
		// whether this abort actually stops the test is only known once the
		// signal-observing awaits settle (e.g. an abort landing during
		// #syncManagerConnection does not stop it).
		abortController.signal.addEventListener("abort", () => {
			if (settled || !hintShown) return;
			hint.set(currentTheme().fg("muted", `Testing connection to "${name}"...`));
		});
		try {
			// Race the config read against Esc: a slow/stuck `#resolveServerForAuth()`
			// (e.g. config on a network FS) must surface cancellation immediately
			// via the catch branch below, not stay suspended until the read settles.
			const found = await raceAbortSignal(
				findMcpServerForAuth(name, getProjectDir(), this.ctx.mcpManager, {
					enableProjectConfig: cfgMcpEnableProjectConfig.get(this.ctx.settings),
				}),
				abortController.signal,
				() => new DOMException("Aborted", "AbortError"),
			);

			if (!found) {
				this.ctx.mcpTestEscapeHandlers.delete(handleEscape);
				this.ctx.showError(
					`Server "${name}" not found.\n\nTip: Run ${currentTheme().fg("accent", "/mcp list")} to see available servers.`,
				);
				return;
			}

			const { config } = found;
			if (config.enabled === false) {
				this.ctx.mcpTestEscapeHandlers.delete(handleEscape);
				this.ctx.showError(`Server "${name}" is disabled. Run /mcp enable ${name} first.`);
				return;
			}

			// Esc may have been consumed during the awaited lookup, before any
			// hint existed. Bail out instead of advertising a cancellation that
			// is already gone.
			if (abortController.signal.aborted) {
				this.ctx.mcpTestEscapeHandlers.delete(handleEscape);
				this.ctx.showStatus(`Cancelled MCP test for "${name}"`);
				return;
			}

			hint.set(
				currentTheme().fg(
					"muted",
					`Testing connection to "${name}"... (${actionKey("app.interrupt", this.ctx.keybindings)} to cancel)`,
				),
			);
			this.ctx.presentCommandOutput(() => mcpTestHintBlock(hint));
			hintShown = true;

			// Resolve auth config if needed
			let resolvedConfig: MCPServerConfig;
			if (this.ctx.mcpManager) {
				resolvedConfig = await this.ctx.mcpManager.prepareConfig(config);
			} else {
				const tempManager = new MCPManager(getProjectDir());
				tempManager.setAuthStorage(this.ctx.session.modelRegistry.authStorage);
				resolvedConfig = await tempManager.prepareConfig(config);
			}

			// Create temporary connection
			// Live: a test answered from the host's store would pass for a server that is down.
			connection = await connectToServer(name, resolvedConfig, { signal: abortController.signal, live: true });

			// List tools to verify connection
			const tools = await listTools(connection, { signal: abortController.signal });

			const lines = [
				"",
				currentTheme().fg(
					"success",
					`${currentTheme().symbols.symbol("status.enabled")} Successfully connected to "${name}"`,
				),
				"",
				`  Server: ${connection.serverInfo.name} v${connection.serverInfo.version}`,
				`  Tools: ${tools.length}`,
			];

			// Show tool names if there are any
			if (tools.length > 0 && tools.length <= 10) {
				lines.push("");
				lines.push("  Available tools:");
				for (const tool of tools) {
					lines.push(`    • ${tool.name}`);
				}
			}

			lines.push("");
			await this.#syncManagerConnection(name, config);
			this.#showMessage(lines.join("\n"));
		} catch (error) {
			if (abortController.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
				settleNote = `Cancelled connection test for "${name}".`;
				this.ctx.showStatus(`Cancelled MCP test for "${name}"`);
				return;
			}

			const errorMsg = error instanceof Error ? error.message : String(error);

			// Provide helpful error messages
			let helpText = "";
			if (errorMsg.includes("ENOENT") || errorMsg.includes("not found")) {
				helpText = "\n\nTip: Check that the command or URL is correct.";
			} else if (errorMsg.includes("EACCES")) {
				helpText = "\n\nTip: Check file/command permissions.";
			} else if (errorMsg.includes("ECONNREFUSED")) {
				helpText = "\n\nTip: Check that the server is running and the URL/port is correct.";
			} else if (errorMsg.includes("timeout")) {
				helpText = "\n\nTip: The server may be slow or unresponsive. Try increasing the timeout.";
			} else if (errorMsg.includes("401") || errorMsg.includes("403")) {
				helpText = "\n\nTip: Check your authentication credentials.";
			}

			settleNote = `Connection test for "${name}" failed.`;
			this.ctx.showError(`Failed to connect to "${name}": ${errorMsg}${helpText}`);
		} finally {
			settled = true;
			if (hintShown) {
				// The test can no longer be cancelled: stop advertising Esc so a
				// later press cannot be mistaken for test cancellation and abort
				// the running agent turn after the grace expires.
				hint.set(currentTheme().fg("muted", settleNote));
			}
			if (this.ctx.mcpTestEscapeHandlers.has(handleEscape)) {
				if (hintShown) {
					const timer = setTimeout(() => {
						this.ctx.mcpTestEscapeHandlers.delete(handleEscape);
					}, MCP_TEST_ESCAPE_GRACE_MS);
					timer.unref();
				} else {
					this.ctx.mcpTestEscapeHandlers.delete(handleEscape);
				}
			}
			if (connection) {
				// Best-effort: don't block UI on cleanup.
				void disconnectServer(connection);
			}
		}
	}

	async #handleSetEnabled(name: string | undefined, enabled: boolean): Promise<void> {
		if (!name) {
			this.ctx.showError(`Server name required. Usage: /mcp ${enabled ? "enable" : "disable"} <name>`);
			return;
		}

		try {
			// A server a built-in transform dropped counts as disabled: enabling it
			// records an explicit enable, which outranks the transform.
			const dropped = this.ctx.mcpManager?.getBuiltinDrops().get(name);
			const found = await findMcpServerForAuth(name, getProjectDir(), this.ctx.mcpManager, {
				enableProjectConfig: cfgMcpEnableProjectConfig.get(this.ctx.settings),
			});
			if (!found) {
				// Check if this is a discovered server from a third-party config
				const userConfigPath = getMCPConfigPath("user", getProjectDir());
				const disabledServers = new Set(await readDisabledServers(userConfigPath));
				const isDiscovered = this.ctx.mcpManager?.getSource(name) ?? dropped?.source;
				const isCurrentlyDisabled = disabledServers.has(name) || dropped !== undefined;
				if (!isDiscovered && !isCurrentlyDisabled) {
					this.ctx.showError(`Server "${name}" not found.`);
					return;
				}
				if (isCurrentlyDisabled === !enabled) {
					this.#showMessage(
						[
							"",
							currentTheme().fg("muted", `Server "${name}" is already ${enabled ? "enabled" : "disabled"}.`),
							"",
						].join("\n"),
					);
					return;
				}
				await setServerDisabled(userConfigPath, name, !enabled);
				if (dropped) await setServerForceEnabled(userConfigPath, name, true);
				if (enabled) {
					await this.#connectEnabledMCPServer(name);
					const state = await this.#waitForServerConnectionWithAnimation(name);
					const status =
						state === "connected"
							? currentTheme().fg("success", "Connected")
							: state === "connecting"
								? currentTheme().fg("muted", "Connecting")
								: currentTheme().fg("warning", "Not connected yet");
					this.#showMessage(
						[
							"",
							currentTheme().fg(
								"success",
								`${currentTheme().symbols.symbol("status.enabled")} Enabled "${name}"`,
							),
							"",
							`  Status: ${status}`,
							"",
						].join("\n"),
					);
				} else {
					await this.ctx.mcpManager?.disconnectServer(name);
					await this.ctx.session.refreshMCPTools(this.ctx.mcpManager?.getTools() ?? []);
					this.#showMessage(
						[
							"",
							currentTheme().fg(
								"muted",
								`${currentTheme().symbols.symbol("status.disabled")} Disabled "${name}"`,
							),
							"",
						].join("\n"),
					);
				}
				return;
			}

			if ((found.config.enabled ?? true) === enabled && !(enabled && dropped)) {
				this.#showMessage(
					[
						"",
						currentTheme().fg("muted", `Server "${name}" is already ${enabled ? "enabled" : "disabled"}.`),
						"",
					].join("\n"),
				);
				return;
			}

			const updated: MCPServerConfig = { ...found.config, enabled };
			await updateMCPServer(found.filePath, name, updated);
			if (enabled) {
				await this.#connectEnabledMCPServer(name);
			} else {
				await this.ctx.mcpManager?.disconnectServer(name);
				await this.ctx.session.refreshMCPTools(this.ctx.mcpManager?.getTools() ?? []);
			}

			let status = "";
			if (enabled) {
				const state = await this.#waitForServerConnectionWithAnimation(name);
				status =
					state === "connected"
						? currentTheme().fg("success", "Connected")
						: state === "connecting"
							? currentTheme().fg("muted", "Connecting")
							: currentTheme().fg("warning", "Not connected yet");
			}

			const lines = [
				"",
				enabled
					? currentTheme().fg(
							"success",
							`${currentTheme().symbols.symbol("status.enabled")} Enabled "${name}" (${found.scope} config)`,
						)
					: currentTheme().fg(
							"muted",
							`${currentTheme().symbols.symbol("status.disabled")} Disabled "${name}" (${found.scope} config)`,
						),
			];
			if (status) {
				lines.push("");
				lines.push(`  Status: ${status}`);
			}
			lines.push("");
			this.#showMessage(lines.join("\n"));
		} catch (error) {
			this.ctx.showError(
				`Failed to ${enabled ? "enable" : "disable"} server: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async #handleUnauth(name: string | undefined): Promise<void> {
		if (!name) {
			this.ctx.showError("Server name required. Usage: /mcp unauth <name>");
			return;
		}

		try {
			const found = await findMcpServerForAuth(name, getProjectDir(), this.ctx.mcpManager, {
				enableProjectConfig: cfgMcpEnableProjectConfig.get(this.ctx.settings),
			});
			if (!found) {
				this.ctx.showError(`Server "${name}" not found.`);
				return;
			}

			const currentAuth = found.config.auth;
			const authStorage = this.ctx.session.modelRegistry.authStorage;
			if (currentAuth?.type === "oauth") {
				await removeManagedMcpOAuthCredential(authStorage, currentAuth.credentialId);
			}
			// Also drop this profile's url-keyed binding so the server is truly
			// signed out even when the config carries no auth block. Runtime
			// discovery expands `${...}` URL values before MCPManager looks up the
			// deterministic credential row, so unauth must clear that same key.
			let removedUrlKeyedCredential = false;
			if ((found.config.type === "http" || found.config.type === "sse") && found.config.url) {
				removedUrlKeyedCredential = await removeManagedMcpOAuthCredentials(
					authStorage,
					mcpOAuthCredentialIdsForServerUrl(found.config.url),
				);
			}

			if (found.discovered && currentAuth?.type !== "oauth") {
				if (!removedUrlKeyedCredential) {
					this.#showMessage(
						["", currentTheme().fg("muted", `No stored OAuth auth to remove for "${name}".`), ""].join("\n"),
					);
					return;
				}
				await this.reloadServers();
				this.#showMessage(
					["", currentTheme().fg("success", `- Cleared auth for "${name}" (${found.scope} config)`), ""].join(
						"\n",
					),
				);
				return;
			}

			const updated = stripMcpOAuthAuth(found.config);
			await updateMCPServer(found.filePath, name, updated);
			await this.reloadServers();

			this.#showMessage(
				["", currentTheme().fg("success", `- Cleared auth for "${name}" (${found.scope} config)`), ""].join("\n"),
			);
		} catch (error) {
			this.ctx.showError(`Failed to clear auth: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Reauthorize a server after a tool-level OAuth challenge. */
	async handleMCPAuthChallenge(name: string, challenge: MCPAuthChallenge): Promise<MCPServerConfig | undefined> {
		return this.#handleReauth(name, { silent: true, reload: false, authChallenge: challenge });
	}

	async #handleReauth(
		name: string | undefined,
		options: { silent?: boolean; reload?: boolean; authChallenge?: MCPAuthChallenge } = {},
	): Promise<MCPServerConfig | undefined> {
		if (!name) {
			if (!options.silent) this.ctx.showError("Server name required. Usage: /mcp reauth <name>");
			return;
		}

		try {
			const found = await findMcpServerForAuth(name, getProjectDir(), this.ctx.mcpManager, {
				enableProjectConfig: cfgMcpEnableProjectConfig.get(this.ctx.settings),
			});
			if (!found) {
				if (!options.silent) this.ctx.showError(`Server "${name}" not found.`);
				return;
			}
			if (found.config.enabled === false) {
				if (!options.silent) this.ctx.showError(`Server "${name}" is disabled. Run /mcp enable ${name} first.`);
				return;
			}

			const { callbacks, release } = this.#oauthFlowCallbacks();
			try {
				const outcome = await this.#withOAuthEscape((signal, onClaimed) =>
					reauthorizeMcpServer(name, found, {
						authStorage: this.ctx.session.modelRegistry.authStorage,
						authChallenge: options.authChallenge,
						mcpManager: this.ctx.mcpManager,
						silent: options.silent,
						signal,
						// Same session-scoped single-flight owner `#handleOAuthFlow`
						// uses: a reauth must supersede (and be superseded by) the
						// add wizard and provider logins, and fail fast while one
						// of them owns manual input, not join the module-global
						// coordinator and contend for the callback port.
						flowOwner: this.ctx.oauthManualInput,
						pendingInput: () =>
							this.ctx.oauthManualInput.hasPending()
								? (this.ctx.oauthManualInput.pendingProviderId ?? "another provider")
								: undefined,
						onReauthorizing: () => {
							this.#showMessage(["", currentTheme().fg("muted", `Reauthorizing "${name}"...`), ""].join("\n"));
						},
						// Install the Esc hook once the flow's claim resolves, so a
						// superseded flow restores nothing (see #withOAuthEscape).
						onClaimed,
						...callbacks,
					}),
				);

				if (options.reload !== false) {
					await this.reloadServers();
					const state = await this.#waitForServerConnectionWithAnimation(name);

					const lines = [
						"",
						currentTheme().fg("success", `✓ Reauthorized "${name}" (${found.scope} config)`),
						"",
						`  Status: ${
							state === "connected"
								? currentTheme().fg("success", "connected")
								: state === "connecting"
									? currentTheme().fg("muted", "connecting")
									: currentTheme().fg("warning", "not connected")
						}`,
						"",
					];
					this.#showMessage(lines.join("\n"));
				}
				return outcome.config;
			} finally {
				release();
			}
		} catch (error) {
			if (error instanceof MCPOAuthCancelledError) {
				if (!options.silent) this.ctx.showStatus(`Reauthorization cancelled for "${name}"`);
				return;
			}
			if (!options.silent) {
				this.ctx.showError(
					`Failed to reauthorize server: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	async #handleReload(): Promise<void> {
		try {
			this.#showMessage(
				["", currentTheme().fg("muted", "Reloading MCP servers and runtime tools..."), ""].join("\n"),
			);
			await this.reloadServers();
			const manager = this.ctx.mcpManager;
			const connectedCount = manager?.getConnectedServers().length ?? 0;
			const connectingCount =
				manager?.getAllServerNames().filter(name => manager.getConnectionStatus(name) === "connecting").length ?? 0;
			this.#showMessage(
				[
					"",
					currentTheme().fg("success", `${currentTheme().symbols.symbol("icon.loop")} MCP reload complete`),
					`  Connected servers: ${connectedCount}`,
					`  Connecting servers: ${connectingCount}`,
					"",
				].join("\n"),
			);
		} catch (error) {
			this.ctx.showError(`Failed to reload MCP: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Handle /mcp reconnect <name> - Reconnect to a specific server.
	 */
	async #handleReconnect(name: string | undefined): Promise<void> {
		if (!name) {
			this.ctx.showError("Server name required. Usage: /mcp reconnect <name>");
			return;
		}
		if (!this.ctx.mcpManager) {
			this.ctx.showError("MCP manager not available.");
			return;
		}

		this.#showMessage(["", currentTheme().fg("muted", `Reconnecting to "${name}"...`), ""].join("\n"));

		try {
			const connection = await this.ctx.mcpManager.reconnectServer(name, { manual: true });
			if (connection) {
				// refreshMCPTools re-registers tools and preserves the user's prior
				// MCP tool selection. No need to call activateDiscoveredMCPTools —
				// that would broaden the selection to all server tools.
				await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
				const serverTools = this.ctx.mcpManager.getTools().filter(t => t.mcpServerName === name);
				this.#showMessage(
					[
						"\n",
						currentTheme().fg(
							"success",
							`${currentTheme().symbols.symbol("status.enabled")} Reconnected to "${name}"`,
						),
						`  Tools: ${serverTools.length}`,
						"\n",
					].join("\n"),
				);
			} else {
				this.ctx.showError(`Failed to reconnect to "${name}". Check server status and logs.`);
			}
		} catch (error) {
			this.ctx.showError(
				`Failed to reconnect to "${name}": ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async #connectEnabledMCPServer(name: string): Promise<void> {
		if (!this.ctx.mcpManager) {
			return;
		}

		const { configs, sources } = await loadAllMCPConfigs(getProjectDir(), {
			extensionRoots: this.ctx.session.effectiveExtensionRoots,
		});
		const config = configs[name];
		if (!config) {
			await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
			return;
		}

		const source = sources[name];
		const result = await this.ctx.mcpManager.connectServers({ [name]: config }, source ? { [name]: source } : {});
		await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
		this.#showMCPConnectionErrors(result.errors);
	}

	#showMCPConnectionErrors(errors: Map<string, string>): void {
		if (errors.size === 0) {
			return;
		}

		const errorLines = ["", currentTheme().fg("warning", "Some servers failed to connect:"), ""];
		for (const [serverName, error] of errors.entries()) {
			errorLines.push(`  ${serverName}: ${error}`);
		}
		errorLines.push("");
		this.#showMessage(errorLines.join("\n"));
	}

	/**
	 * Reconnect every configured MCP server and rebind the session's MCP tools.
	 *
	 * Disconnects all live connections, rediscovers `.mcp.json` configs, and
	 * calls `session.refreshMCPTools(...)` so config edits take effect without a
	 * restart. Public because `/reload-plugins` reuses it alongside `/mcp reload`
	 * and the config-mutation flows in this controller.
	 *
	 * Discovery options are derived from settings so the reload honors the same
	 * opt-outs as startup — notably `mcp.enableProjectConfig: false`, which must
	 * keep project `.mcp.json` servers from being started on reload.
	 */
	async reloadServers(): Promise<void> {
		if (!this.ctx.mcpManager) {
			return;
		}

		// Rediscover and connect, mirroring startup's discovery filters.
		const result = await reconnectMCPServers(this.ctx.mcpManager, this.ctx.session, {
			enableProjectConfig: cfgMcpEnableProjectConfig.get(this.ctx.settings),
			filterExa: true,
			filterBrowser: this.ctx.session.getEvalPreludes().some(definition => definition.name === "browser"),
			builtinTransforms: resolveMCPTransformContext(this.ctx.settings, {
				evalActive: this.ctx.session.getActiveToolNames().includes("eval"),
			}),
			extensionRoots: this.ctx.session.effectiveExtensionRoots,
		});

		this.#showMCPConnectionErrors(result.errors);
	}

	/**
	 * Handle /mcp resources - Show available resources from connected servers
	 */
	async #handleResources(): Promise<void> {
		if (!this.ctx.mcpManager) {
			this.ctx.showError("No MCP manager available.");
			return;
		}

		const servers = this.ctx.mcpManager.getConnectedServers();
		const lines: string[] = [];
		let hasAny = false;

		for (const name of servers) {
			const data = this.ctx.mcpManager.getServerResources(name);
			if (!data) continue;
			const { resources, templates } = data;
			if (resources.length === 0 && templates.length === 0) continue;
			hasAny = true;

			lines.push(`${currentTheme().fg("accent", name)}:`);
			for (const r of resources) {
				const desc = r.description ? ` ${currentTheme().fg("dim", r.description)}` : "";
				const mime = r.mimeType ? ` ${currentTheme().fg("dim", `[${r.mimeType}]`)}` : "";
				lines.push(`  ${currentTheme().fg("success", r.uri)}${mime}${desc}`);
			}
			if (templates.length > 0) {
				lines.push(`  ${currentTheme().fg("muted", "Templates:")}`);
				for (const t of templates) {
					const desc = t.description ? ` ${currentTheme().fg("dim", t.description)}` : "";
					lines.push(`    ${currentTheme().fg("accent", t.uriTemplate)}${desc}`);
				}
			}
			lines.push("");
		}

		if (!hasAny) {
			lines.push(currentTheme().fg("muted", "No resources available on connected servers."));
		}
		this.#showReport("MCP Resources", lines.join("\n"));
	}

	/**
	 * Handle /mcp prompts - Show available prompts from connected servers
	 */
	async #handlePrompts(): Promise<void> {
		if (!this.ctx.mcpManager) {
			this.ctx.showError("No MCP manager available.");
			return;
		}

		const servers = this.ctx.mcpManager.getConnectedServers();
		const lines: string[] = [];
		let hasAny = false;

		for (const name of servers) {
			const prompts = this.ctx.mcpManager.getServerPrompts(name);
			if (!prompts?.length) continue;
			hasAny = true;

			lines.push(`${currentTheme().fg("accent", name)}:`);
			for (const p of prompts) {
				const commandName = `${name}:${p.name}`;
				const desc = p.description ? ` ${currentTheme().fg("dim", p.description)}` : "";
				lines.push(`  ${currentTheme().fg("success", `/${commandName}`)}${desc}`);
				if (p.arguments?.length) {
					for (const arg of p.arguments) {
						const required = arg.required ? currentTheme().fg("warning", " *") : "";
						const argDesc = arg.description ? ` - ${arg.description}` : "";
						lines.push(`    ${arg.name}=${required}${currentTheme().fg("dim", argDesc)}`);
					}
				}
			}
			lines.push("");
		}

		if (!hasAny) {
			lines.push(currentTheme().fg("muted", "No prompts available on connected servers."));
		}
		this.#showReport("MCP Prompts", lines.join("\n"));
	}

	/**
	 * Handle /mcp notifications - Show notification and subscription state
	 */
	async #handleNotifications(): Promise<void> {
		if (!this.ctx.mcpManager) {
			this.ctx.showError("No MCP manager available.");
			return;
		}

		const { enabled, subscriptions } = this.ctx.mcpManager.getNotificationState();
		const servers = this.ctx.mcpManager.getConnectedServers();
		const statusIcon = enabled ? currentTheme().fg("success", "enabled") : currentTheme().fg("warning", "disabled");
		const lines: string[] = [];
		lines.push(`  Status: ${statusIcon}  ${currentTheme().fg("dim", "(mcp.notifications setting)")}`);
		lines.push("");

		let hasAny = false;
		for (const name of servers) {
			const connection = this.ctx.mcpManager.getConnection(name);
			if (!connection) continue;
			const caps = connection.capabilities;
			const supportsResources = caps.resources !== undefined;
			const supportsSubscribe = caps.resources?.subscribe === true;
			const supportsToolsChanged = caps.tools?.listChanged === true;
			const supportsPromptsChanged = caps.prompts?.listChanged === true;
			const supportsResourcesChanged = caps.resources?.listChanged === true;

			const hasNotifications =
				supportsToolsChanged || supportsPromptsChanged || supportsResourcesChanged || supportsSubscribe;
			if (!hasNotifications) continue;
			hasAny = true;

			lines.push(`${currentTheme().fg("accent", name)}:`);
			const check = currentTheme().fg("success", "✓");
			const cross = currentTheme().fg("dim", "✗");
			if (supportsToolsChanged) lines.push(`  ${check} tools/list_changed`);
			if (supportsResourcesChanged) lines.push(`  ${check} resources/list_changed`);
			if (supportsPromptsChanged) lines.push(`  ${check} prompts/list_changed`);

			if (supportsSubscribe) {
				const subscribedUris = subscriptions.get(name);
				const subCount = subscribedUris?.size ?? 0;
				const subStatus =
					enabled && subCount > 0
						? currentTheme().fg("success", `subscribed (${subCount} URI${subCount !== 1 ? "s" : ""})`)
						: enabled
							? currentTheme().fg("muted", "no active subscriptions")
							: currentTheme().fg("dim", "inactive (notifications disabled)");
				lines.push(`  ${check} resources/subscribe  ${subStatus}`);
				if (enabled && subscribedUris && subscribedUris.size > 0) {
					for (const uri of subscribedUris) {
						lines.push(`    ${currentTheme().fg("success", "✓")} ${currentTheme().fg("dim", uri)}`);
					}
				}
			} else if (supportsResources) {
				lines.push(`  ${cross} resources/subscribe  ${currentTheme().fg("dim", "not supported")}`);
			}
			lines.push("");
		}

		if (!hasAny) {
			lines.push(currentTheme().fg("muted", "No servers support notifications."));
		}
		this.#showReport("MCP Notifications", lines.join("\n"));
	}

	/**
	 * Show a message in the chat
	 */
	#showMessage(text: string): void {
		showCommandMessage(this.ctx, text);
	}

	/** A read-only listing shown outside the transcript (see `InteractiveModeContext.showCommandReport`). */
	#showReport(title: string, text: string): void {
		this.ctx.showCommandReport({ title, body: () => reportTextView(text.trim()) });
	}
}
