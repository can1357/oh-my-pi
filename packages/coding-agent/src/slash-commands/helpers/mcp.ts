import * as AIError from "@oh-my-pi/pi-ai/error";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/oauth/types";
import { getMCPConfigPath, logger, withTimeout } from "@oh-my-pi/pi-utils";
import { expandEnvVarsDeep } from "../../discovery/helpers";
import { connectToServer, disconnectServer, listPrompts, listResources, listTools } from "../../mcp/client";
import {
	addMCPServer,
	readDisabledServers,
	readMCPConfigFile,
	removeMCPServer,
	setServerDisabled,
	updateMCPServer,
} from "../../mcp/config-writer";
import { MCPManager } from "../../mcp/manager";
import {
	analyzeAuthError,
	discoverOAuthEndpoints,
	fetchResourceMetadataScopes,
	type OAuthEndpoints,
} from "../../mcp/oauth-discovery";
import { lookupMcpOAuthCredentialForServer, removeManagedMcpOAuthCredential } from "../../mcp/oauth-credentials";
import { MCPOAuthFlow, type MCPStoredOAuthCredential, mcpOAuthCredentialId } from "../../mcp/oauth-flow";
import { getSmitheryApiKey } from "../../mcp/smithery-auth";
import { searchSmitheryRegistry } from "../../mcp/smithery-registry";
import type { MCPServerConfig, MCPServerConnection } from "../../mcp/types";
import { parseCommandArgs } from "../../utils/command-args";
import { openPath } from "../../utils/open";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, errorMessage, parseNamedScopeArgs, parseSubcommand, usage } from "./parse";

type AcpMcpScope = "user" | "project";

interface ParsedMcpAddArgs {
	name?: string;
	scope: AcpMcpScope;
	url?: string;
	transport: "http" | "sse";
	authToken?: string;
	commandTokens?: string[];
	error?: string;
}

interface ParsedMcpSearchArgs {
	keyword: string;
	scope: AcpMcpScope;
	limit: number;
	semantic: boolean;
	error?: string;
}

type McpAddOptionParser = (parsed: ParsedMcpAddArgs, value: string | undefined) => string | undefined;

const MCP_ADD_USAGE =
	"Usage: /mcp add <name> [--scope project|user] [--url <url> --transport http|sse] [--token <token>] [-- <command...>]";

const MCP_ADD_OPTION_PARSERS = new Map<string, McpAddOptionParser>([
	[
		"--scope",
		(parsed, value) => {
			if (!value || (value !== "project" && value !== "user")) return "Invalid --scope value. Use project or user.";
			parsed.scope = value;
			return undefined;
		},
	],
	[
		"--url",
		(parsed, value) => {
			if (!value) return "Missing value for --url.";
			parsed.url = value;
			return undefined;
		},
	],
	[
		"--transport",
		(parsed, value) => {
			if (!value || (value !== "http" && value !== "sse")) return "Invalid --transport value. Use http or sse.";
			parsed.transport = value;
			return undefined;
		},
	],
	[
		"--token",
		(parsed, value) => {
			if (!value) return "Missing value for --token.";
			parsed.authToken = value;
			return undefined;
		},
	],
]);

async function getMcpConfiguredServers(
	cwd: string,
): Promise<Array<{ name: string; config: MCPServerConfig; scope: AcpMcpScope }>> {
	const userPath = getMCPConfigPath("user", cwd);
	const projectPath = getMCPConfigPath("project", cwd);
	const [userConfig, projectConfig] = await Promise.all([readMCPConfigFile(userPath), readMCPConfigFile(projectPath)]);
	const servers: Array<{ name: string; config: MCPServerConfig; scope: AcpMcpScope }> = [];
	const seen = new Set<string>();
	for (const [name, config] of Object.entries(projectConfig.mcpServers ?? {})) {
		if (config.enabled !== false) {
			servers.push({ name, config, scope: "project" });
			seen.add(name);
		}
	}
	for (const [name, config] of Object.entries(userConfig.mcpServers ?? {})) {
		if (!seen.has(name) && config.enabled !== false) servers.push({ name, config, scope: "user" });
	}
	return servers;
}

function validateParsedMcpAddArgs(parsed: ParsedMcpAddArgs): ParsedMcpAddArgs {
	const hasCommand = (parsed.commandTokens?.length ?? 0) > 0;
	const hasUrl = Boolean(parsed.url);
	if (!hasCommand && !hasUrl) {
		return {
			...parsed,
			error: "Provide --url or -- <command...> for non-interactive add. Usage: /mcp add <name> [--scope project|user] [--url <url> --transport http|sse] [--token <token>] [-- <command...>]",
		};
	}
	if (!parsed.name) return { ...parsed, error: "Server name required. Usage: /mcp add <name> ..." };
	if (hasCommand && hasUrl) return { ...parsed, error: "Use either --url or -- <command...>, not both." };
	if (parsed.authToken && !hasUrl) return { ...parsed, error: "--token requires --url (HTTP/SSE transport)." };
	return parsed;
}

function parseMcpAddArgs(rest: string): ParsedMcpAddArgs {
	const tokens = parseCommandArgs(rest);
	const parsed: ParsedMcpAddArgs = { scope: "project", transport: "http" };
	if (tokens.length === 0) return parsed;

	let index = 0;
	if (!tokens[0]!.startsWith("-")) {
		parsed.name = tokens[0];
		index = 1;
	}

	while (index < tokens.length) {
		const arg = tokens[index]!;
		if (arg === "--") {
			parsed.commandTokens = tokens.slice(index + 1);
			break;
		}
		const parser = MCP_ADD_OPTION_PARSERS.get(arg);
		if (!parser) return { ...parsed, error: `Unknown option: ${arg}` };
		const error = parser(parsed, tokens[index + 1]);
		if (error) return { ...parsed, error };
		index += 2;
	}

	return validateParsedMcpAddArgs(parsed);
}

function parseMcpSearchArgs(rest: string): ParsedMcpSearchArgs {
	const tokens = parseCommandArgs(rest);
	const missingKeyword: ParsedMcpSearchArgs = {
		keyword: "",
		scope: "project",
		limit: 20,
		semantic: false,
		error: "Keyword required. Usage: /mcp smithery-search <keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
	};
	if (tokens.length === 0) return missingKeyword;

	const keywordParts: string[] = [];
	let scope: AcpMcpScope = "project";
	let limit = 20;
	let semantic = false;

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (token === "--scope") {
			const value = tokens[index + 1];
			if (!value || (value !== "project" && value !== "user")) {
				return { keyword: "", scope, limit, semantic, error: "Invalid --scope value. Use project or user." };
			}
			scope = value;
			index++;
			continue;
		}
		if (token === "--limit") {
			const value = tokens[index + 1];
			if (!value) return { keyword: "", scope, limit, semantic, error: "Missing value for --limit." };
			const parsed = Number(value);
			if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
				return {
					keyword: "",
					scope,
					limit,
					semantic,
					error: "Invalid --limit value. Use an integer between 1 and 100.",
				};
			}
			limit = parsed;
			index++;
			continue;
		}
		if (token === "--semantic") {
			semantic = true;
			continue;
		}
		if (token.startsWith("--")) return { keyword: "", scope, limit, semantic, error: `Unknown option: ${token}` };
		keywordParts.push(token);
	}

	const keyword = keywordParts.join(" ").trim();
	if (!keyword) return { ...missingKeyword, scope, limit, semantic };
	return { keyword, scope, limit, semantic };
}

async function withPreparedMcpConnection<T>(
	runtime: SlashCommandRuntime,
	name: string,
	config: MCPServerConfig,
	fn: (connection: MCPServerConnection) => Promise<T>,
): Promise<T> {
	let connection: MCPServerConnection | undefined;
	try {
		const manager = new MCPManager(runtime.cwd);
		// Auth storage must be wired in before prepareConfig so OAuth-backed
		// servers can refresh credentials and inject Authorization headers.
		// Without this, `/mcp test|resources|prompts` silently fails for any
		// server saved by the TUI/reauth path.
		manager.setAuthStorage(runtime.session.modelRegistry.authStorage);
		const resolvedConfig = await manager.prepareConfig(config);
		connection = await connectToServer(name, resolvedConfig);
		return await fn(connection);
	} finally {
		if (connection) {
			// Await cleanup so the stdio subprocess / HTTP DELETE has actually
			// released the resource before this helper returns. Fire-and-forget
			// here races with subsequent connect attempts and turns close
			// failures into unhandled rejections.
			try {
				await disconnectServer(connection);
			} catch (err) {
				logger.warn("MCP disconnect after temporary connection failed", { name, err });
			}
		}
	}
}

async function collectConnectedMcpLines(
	runtime: SlashCommandRuntime,
	collect: (serverName: string, connection: MCPServerConnection) => Promise<string[]>,
): Promise<string[] | undefined> {
	const servers = await getMcpConfiguredServers(runtime.cwd);
	if (servers.length === 0) return undefined;

	const lines: string[] = [];
	for (const { name, config } of servers) {
		try {
			const collected = await withPreparedMcpConnection(runtime, name, config, connection =>
				collect(name, connection),
			);
			lines.push(...collected);
		} catch {
			// unreachable server: skip silently
		}
	}
	return lines;
}

async function handleResourcesCommand(runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const lines = await collectConnectedMcpLines(runtime, async (name, connection) => {
		const resources = await listResources(connection);
		return resources.map(resource => `${name}/${resource.uri}`);
	});
	if (!lines) {
		await runtime.output("No MCP servers configured.");
		return commandConsumed();
	}
	await runtime.output(lines.length > 0 ? lines.join("\n") : "No resources available on connected servers.");
	return commandConsumed();
}

async function handlePromptsCommand(runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const lines = await collectConnectedMcpLines(runtime, async (name, connection) => {
		const prompts = await listPrompts(connection);
		return prompts.map(prompt => `${name}/${prompt.name}${prompt.description ? ` — ${prompt.description}` : ""}`);
	});
	if (!lines) {
		await runtime.output("No MCP servers configured.");
		return commandConsumed();
	}
	await runtime.output(lines.length > 0 ? lines.join("\n") : "No prompts available on connected servers.");
	return commandConsumed();
}

async function handleTestCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const name = rest.split(/\s+/)[0]?.trim() ?? "";
	if (!name) return usage("Usage: /mcp test <name>", runtime);
	const servers = await getMcpConfiguredServers(runtime.cwd);
	const server = servers.find(item => item.name === name);
	if (!server) return usage(`Server "${name}" not found. Run /mcp list to see configured servers.`, runtime);

	try {
		return await withPreparedMcpConnection(runtime, name, server.config, async connection => {
			const tools = await listTools(connection);
			const lines = [`Server "${name}" connected (${tools.length} tools).`];
			for (const tool of tools) lines.push(`  - ${tool.name}`);
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		});
	} catch (err) {
		return usage(`Connection to "${name}" failed: ${errorMessage(err)}`, runtime);
	}
}

function buildMcpServerConfig(parsed: ParsedMcpAddArgs): MCPServerConfig | undefined {
	if (parsed.commandTokens && parsed.commandTokens.length > 0) {
		const [command, ...args] = parsed.commandTokens;
		return { type: "stdio", command: command!, args: args.length > 0 ? args : undefined } as MCPServerConfig;
	}
	if (!parsed.url) return undefined;
	const normalizedUrl = /^https?:\/\//i.test(parsed.url) ? parsed.url : `https://${parsed.url}`;
	return {
		type: parsed.transport === "sse" ? "sse" : "http",
		url: normalizedUrl,
		headers: parsed.authToken ? { Authorization: `Bearer ${parsed.authToken}` } : undefined,
	} as MCPServerConfig;
}

async function handleAddCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	if (!rest) return usage(MCP_ADD_USAGE, runtime);
	const parsed = parseMcpAddArgs(rest);
	if (parsed.error) return usage(parsed.error, runtime);
	if (!parsed.name) return usage(MCP_ADD_USAGE, runtime);
	const config = buildMcpServerConfig(parsed);
	if (!config) return usage(MCP_ADD_USAGE, runtime);
	try {
		const filePath = getMCPConfigPath(parsed.scope, runtime.cwd);
		await addMCPServer(filePath, parsed.name, config);
		await runtime.output(`Added MCP server "${parsed.name}" (${parsed.scope}).`);
		return commandConsumed();
	} catch (err) {
		return usage(`Failed to add server: ${errorMessage(err)}`, runtime);
	}
}

async function handleSmitherySearchCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseMcpSearchArgs(rest);
	if (parsed.error) return usage(parsed.error, runtime);
	try {
		const apiKey = await getSmitheryApiKey();
		const results = await searchSmitheryRegistry(parsed.keyword, {
			limit: parsed.limit,
			apiKey: apiKey ?? undefined,
			includeSemantic: parsed.semantic,
		});
		if (results.length === 0) {
			await runtime.output(`No Smithery results found for "${parsed.keyword}".`);
			return commandConsumed();
		}
		await runtime.output(
			results
				.map(
					result =>
						`${result.display.displayName} (${result.name})${result.display.description ? ` — ${result.display.description}` : ""}`,
				)
				.join("\n"),
		);
		return commandConsumed();
	} catch (err) {
		const message = errorMessage(err);
		if (AIError.is(AIError.classify(err), AIError.Flag.AuthFailed)) {
			return usage(
				"Smithery authentication required. Run /mcp smithery-login in the TUI client or add an API key to ~/.omp/agent/smithery.json.",
				runtime,
			);
		}
		return usage(`Smithery search failed: ${message}`, runtime);
	}
}

async function handleListCommand(runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	try {
		const userPath = getMCPConfigPath("user", runtime.cwd);
		const projectPath = getMCPConfigPath("project", runtime.cwd);
		const [userConfig, projectConfig] = await Promise.all([
			readMCPConfigFile(userPath),
			readMCPConfigFile(projectPath),
		]);
		const disabledSet = new Set(await readDisabledServers(userPath));
		const entries: Array<{ name: string; config: MCPServerConfig; scope: string }> = [];
		for (const [name, config] of Object.entries(userConfig.mcpServers ?? {})) {
			entries.push({ name, config, scope: "user" });
		}
		for (const [name, config] of Object.entries(projectConfig.mcpServers ?? {})) {
			if (!entries.some(entry => entry.name === name)) entries.push({ name, config, scope: "project" });
		}
		if (entries.length === 0) {
			await runtime.output("No MCP servers configured.");
			return commandConsumed();
		}
		await runtime.output(
			entries
				.map(({ name, config, scope }) => {
					const type = config.type ?? "stdio";
					const enabled = config.enabled !== false && !disabledSet.has(name) ? "enabled" : "disabled";
					let location: string | undefined;
					if (config.type === "http" || config.type === "sse") {
						// Strip query string and userinfo from URLs to avoid leaking
						// API keys carried in the query (e.g. `?apiKey=…`). Skip the
						// redaction entirely for missing/empty URLs so the row falls
						// back to `(unknown)` rather than the misleading `(hidden)`
						// label reserved for unparseable values.
						const raw = (config as { url?: string }).url;
						if (raw) {
							try {
								const parsed = new URL(raw);
								const pathOnly = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "";
								location = `${parsed.origin}${pathOnly}`;
							} catch {
								location = "(hidden)";
							}
						}
					} else {
						location = (config as { command: string }).command;
					}
					return `${name} | ${type} | ${enabled} | ${location ?? "(unknown)"} [${scope}]`;
				})
				.join("\n"),
		);
		return commandConsumed();
	} catch (err) {
		return usage(`Failed to list MCP servers: ${errorMessage(err)}`, runtime);
	}
}

async function handleEnableDisableCommand(
	verb: "enable" | "disable",
	rest: string,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const name = rest.split(/\s+/)[0] ?? "";
	if (!name) return usage(`Usage: /mcp ${verb} <name>`, runtime);
	const enabled = verb === "enable";
	try {
		const userPath = getMCPConfigPath("user", runtime.cwd);
		const projectPath = getMCPConfigPath("project", runtime.cwd);
		const [userConfig, projectConfig] = await Promise.all([
			readMCPConfigFile(userPath),
			readMCPConfigFile(projectPath),
		]);
		if (projectConfig.mcpServers?.[name] !== undefined) {
			await updateMCPServer(projectPath, name, { ...projectConfig.mcpServers[name], enabled } as MCPServerConfig);
			await runtime.output(`Server "${name}" ${enabled ? "enabled" : "disabled"} (project config).`);
			return commandConsumed();
		}
		if (userConfig.mcpServers?.[name] !== undefined) {
			await updateMCPServer(userPath, name, { ...userConfig.mcpServers[name], enabled } as MCPServerConfig);
			await runtime.output(`Server "${name}" ${enabled ? "enabled" : "disabled"} (user config).`);
			return commandConsumed();
		}
		const disabledList = await readDisabledServers(userPath);
		if (!enabled || disabledList.includes(name)) {
			await setServerDisabled(userPath, name, !enabled);
			await runtime.output(`Server "${name}" ${enabled ? "enabled" : "disabled"}.`);
			return commandConsumed();
		}
		return usage(`Server "${name}" not found in user or project config.`, runtime);
	} catch (err) {
		return usage(`Failed to ${verb} MCP server: ${errorMessage(err)}`, runtime);
	}
}

async function handleRemoveCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseNamedScopeArgs(rest, "Invalid --scope value. Use project or user.");
	if (parsed.error) return usage(parsed.error, runtime);
	if (!parsed.name) return usage("Usage: /mcp remove <name> [--scope project|user]", runtime);
	try {
		const filePath = getMCPConfigPath(parsed.scope, runtime.cwd);
		await removeMCPServer(filePath, parsed.name);
		await runtime.output(`Removed server "${parsed.name}" from ${parsed.scope} config.`);
		return commandConsumed();
	} catch (err) {
		return usage(`Failed to remove MCP server: ${errorMessage(err)}`, runtime);
	}
}

/** Strip the `auth` block so a probe or flow starts from the raw server config. */
function stripMcpOAuthAuth(config: MCPServerConfig): MCPServerConfig {
	const next = { ...config };
	delete next.auth;
	return next;
}

/**
 * Resolve OAuth endpoints for a reauth: probe anonymously first (nothing
 * destructive has happened yet), and either take discovery metadata (a clean
 * `initialize` is only weak evidence per the MCP spec, so honor the explicit
 * reauth when the server advertises OAuth) or analyze the auth failure and
 * discover from it. Mirrors `McpCommandController#resolveOAuthEndpointsFromServer`
 * for the non-interactive path.
 */
async function resolveReauthEndpoints(config: MCPServerConfig, runtime: SlashCommandRuntime): Promise<OAuthEndpoints> {
	const serverUrl = config.type === "http" || config.type === "sse" ? config.url : undefined;
	const manager = new MCPManager(runtime.cwd);
	manager.setAuthStorage(runtime.session.modelRegistry.authStorage);
	const probeConfig = await manager.prepareConfig(config, { oauth: false });
	let connectionError: Error | undefined;
	let connection: MCPServerConnection | undefined;
	try {
		connection = await connectToServer(`reauth_probe_${Date.now()}`, probeConfig);
	} catch (error) {
		connectionError = error instanceof Error ? error : new Error(String(error));
	} finally {
		if (connection) {
			try {
				await disconnectServer(connection);
			} catch (err) {
				logger.warn("MCP disconnect after reauth probe failed", { err });
			}
		}
	}
	if (!connectionError) {
		const discovered = serverUrl ? await discoverOAuthEndpoints(serverUrl) : null;
		if (!discovered) {
			throw new Error("Server connection succeeded without OAuth; reauthorization is not required.");
		}
		return discovered;
	}
	const authResult = analyzeAuthError(connectionError, serverUrl);
	let oauth = authResult.authType === "oauth" ? (authResult.oauth ?? null) : null;
	if (!oauth && serverUrl) {
		oauth = await discoverOAuthEndpoints(serverUrl, authResult.authServerUrl, authResult.resourceMetadataUrl, {
			protectedScopes: authResult.scopes,
		});
	}
	if (oauth && !oauth.scopes && authResult.resourceMetadataUrl) {
		const scopes = await fetchResourceMetadataScopes(authResult.resourceMetadataUrl);
		if (scopes) oauth = { ...oauth, scopes };
	}
	if (!oauth) {
		throw new Error(`Could not discover OAuth endpoints from the server response: ${connectionError.message}`);
	}
	return oauth;
}

/**
 * `/mcp reauth <name>` for ACP/text mode. omp runs on the user's machine even
 * when driven over ACP (emacs, Zed, …), so opening the browser works exactly
 * like the TUI: the same `MCPOAuthFlow` local callback server, `openPath` to
 * launch the default browser, and the same persistence policy
 * (`McpCommandController#persistOAuthResult`): the auth block records the
 * credential pointer plus refresh material, the oauth block echoes the client
 * id for pre-auth reuse, and only a user-supplied client secret is ever
 * written back — DCR-issued secrets stay embedded in the stored credential so
 * they cannot leak into (possibly shared/committed) config files.
 *
 * No clipboard copy here: OSC 52 escape sequences would corrupt the ACP
 * JSON-RPC stream on stdout, so the URL is emitted as text for the client to
 * render instead. No manual-code input either: ACP has no composer to claim;
 * the URL is the fallback when the browser cannot open (e.g. a remote host).
 */
async function handleReauthCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const name = rest.split(/\s+/)[0]?.trim() ?? "";
	if (!name) return usage("Usage: /mcp reauth <name>", runtime);
	const servers = await getMcpConfiguredServers(runtime.cwd);
	const found = servers.find(item => item.name === name);
	if (!found) return usage(`Server "${name}" not found. Run /mcp list to see configured servers.`, runtime);

	const baseConfig = stripMcpOAuthAuth(found.config);
	const runtimeBaseConfig = expandEnvVarsDeep(baseConfig);
	if (runtimeBaseConfig.type !== "http" && runtimeBaseConfig.type !== "sse") {
		const remoteUrl = runtimeBaseConfig.args?.find(arg => /^https?:\/\//.test(arg));
		const httpHint = `{ "type": "http", "url": ${JSON.stringify(remoteUrl ?? "<remote url>")} }`;
		const usesMcpRemote = [runtimeBaseConfig.command, ...(runtimeBaseConfig.args ?? [])].some(part =>
			part?.includes("mcp-remote"),
		);
		return usage(
			usesMcpRemote
				? `this server proxies OAuth through mcp-remote, which caches tokens machine-wide in ~/.mcp-auth (shared across every OMP profile). Clear ~/.mcp-auth to force a fresh login, or replace the proxy with ${httpHint} so OMP manages OAuth per profile.`
				: `stdio servers manage their own credentials, so OMP has no OAuth to reauthorize. If the service supports OAuth over HTTP, configure it as ${httpHint} instead.`,
			runtime,
		);
	}
	const serverUrl = runtimeBaseConfig.url;

	const authStorage = runtime.session.modelRegistry.authStorage;
	let endpoints: OAuthEndpoints;
	try {
		endpoints = await resolveReauthEndpoints(runtimeBaseConfig, runtime);
	} catch (error) {
		return usage(`Failed to reauthorize "${name}": ${errorMessage(error)}`, runtime);
	}

	// Client-credential assembly, mirroring the TUI reauth path: configured
	// > previously registered > stored > (metadata-advertised, only when the
	// authorization server offers no DCR) — so DCR stays preferred.
	const currentAuth = found.config.auth;
	const runtimeAuth = currentAuth ? expandEnvVarsDeep(currentAuth) : undefined;
	const configuredClientId = runtimeBaseConfig.oauth?.clientId?.trim() || undefined;
	const configuredClientSecret = runtimeBaseConfig.oauth?.clientSecret;
	const existingCredential = lookupMcpOAuthCredentialForServer(authStorage, currentAuth, serverUrl)?.credential;
	const persistedClientId = runtimeAuth?.clientId?.trim() || undefined;
	const storedClientId = existingCredential?.clientId?.trim() || undefined;
	const discoveredClientId = endpoints.clientId?.trim() || undefined;
	const flowClientId =
		configuredClientId ??
		persistedClientId ??
		storedClientId ??
		(endpoints.registrationUrl ? undefined : discoveredClientId) ??
		"";
	const storedClientSecret = storedClientId === flowClientId ? existingCredential?.clientSecret : undefined;
	const flowClientSecret =
		(configuredClientId === flowClientId ? configuredClientSecret : undefined) ??
		(persistedClientId === flowClientId ? runtimeAuth?.clientSecret : undefined) ??
		storedClientSecret ??
		"";
	// Only a user-supplied secret is ever written back to config; keep the raw
	// `${...}` placeholder in the file rather than the resolved secret.
	const userClientSecret =
		(configuredClientId === flowClientId ? found.config.oauth?.clientSecret : undefined) ??
		(persistedClientId === flowClientId ? currentAuth?.clientSecret : undefined);
	const hasConfiguredOnlySecret = configuredClientId === undefined && configuredClientSecret !== undefined;

	const currentAuthResource = currentAuth?.resource ? expandEnvVarsDeep(currentAuth.resource) : undefined;
	const oauthResource = endpoints.resource ?? currentAuthResource ?? serverUrl;
	const oauthResourceIsFallback = !endpoints.resource && !currentAuthResource;

	await runtime.output(`Reauthorizing "${name}"… opening your browser (5 minute timeout).`);

	const abort = new AbortController();
	const onHostAbort = () => abort.abort("MCP reauth cancelled by host");
	runtime.signal?.addEventListener("abort", onHostAbort, { once: true });
	try {
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: endpoints.authorizationUrl,
				tokenUrl: endpoints.tokenUrl,
				registrationUrl: endpoints.registrationUrl,
				issuerUrl: endpoints.issuerUrl,
				clientId: flowClientId,
				clientSecret: flowClientSecret,
				scopes: endpoints.scopes || runtimeBaseConfig.oauth?.scope || "",
				prompt: found.config.oauth?.prompt,
				redirectUri: found.config.oauth?.redirectUri,
				callbackPort: found.config.oauth?.callbackPort,
				callbackPath: found.config.oauth?.callbackPath,
				resource: oauthResource,
				stripSameOriginResource: oauthResourceIsFallback,
			},
			{
				signal: abort.signal,
				onAuth: info => {
					openPath(info.url);
					void Promise.resolve(
						runtime.output(
							[
								"━━━ OAuth Authorization Required ━━━",
								"Opening your browser to authorize. If it did not open:",
								info.url,
								...(info.instructions ? ["", info.instructions] : []),
							].join("\n"),
						),
					).catch(() => {});
				},
				onProgress: message => {
					void Promise.resolve(runtime.output(message)).catch(() => {});
				},
			},
		);
		let credentials: OAuthCredentials;
		try {
			credentials = await withTimeout(flow.login(), 5 * 60_000, "OAuth flow timed out after 5 minutes");
		} catch (error) {
			if (abort.signal.aborted) {
				await runtime.output(`Reauthorization cancelled for "${name}".`);
				return commandConsumed();
			}
			throw error;
		}

		const credentialId = mcpOAuthCredentialId(serverUrl);
		const oauthCredential: MCPStoredOAuthCredential = {
			...credentials,
			type: "oauth",
			tokenUrl: endpoints.tokenUrl,
			clientId: flow.resolvedClientId?.trim() || flowClientId,
			clientSecret: flow.registeredClientSecret ?? flowClientSecret,
			resource: flow.resource,
			authorizationUrl: flow.authorizationUrl,
		};
		await authStorage.credentials.set(credentialId, oauthCredential);

		// The flow overwrote (or minted) this profile's row; a superseded pointer
		// row from the legacy random-id era is now orphaned. GC only after
		// success so cancelling the browser step leaves the previous session
		// signed in.
		if (currentAuth?.type === "oauth" && currentAuth.credentialId && currentAuth.credentialId !== credentialId) {
			await removeManagedMcpOAuthCredential(authStorage, currentAuth.credentialId);
		}

		// Definition-only entries resolve through the url-keyed binding alone;
		// skip the write-back so a committed project mcp.json stays clean.
		const urlKeyedId = serverUrl ? mcpOAuthCredentialId(serverUrl) : undefined;
		if (currentAuth || credentialId !== urlKeyedId) {
			const clientIdForConfig =
				flow.resolvedClientId?.trim() || flowClientId || found.config.oauth?.clientId?.trim();
			const oauthClientId = hasConfiguredOnlySecret ? undefined : clientIdForConfig;
			const resource =
				flow.resource ?? (oauthResourceIsFallback ? undefined : oauthResource) ?? currentAuth?.resource;
			const updatedConfig: MCPServerConfig = {
				...baseConfig,
				auth: {
					type: "oauth",
					credentialId,
					tokenUrl: endpoints.tokenUrl,
					clientId: clientIdForConfig,
					clientSecret: userClientSecret,
					resource,
				},
				oauth: {
					...found.config.oauth,
					clientId: oauthClientId,
				},
			};
			await updateMCPServer(getMCPConfigPath(found.scope, runtime.cwd), name, updatedConfig);
		}
		await runtime.output(`✓ Reauthorized "${name}" (${found.scope} config).`);
		return commandConsumed();
	} catch (error) {
		return usage(`Failed to reauthorize server "${name}": ${errorMessage(error)}`, runtime);
	} finally {
		runtime.signal?.removeEventListener("abort", onHostAbort);
	}
}

const MCP_HELP_TEXT = [
	"MCP server management (ACP mode)",
	"  /mcp list                                               List configured servers",
	"  /mcp enable <name>                                      Enable a server",
	"  /mcp disable <name>                                     Disable a server",
	"  /mcp remove <name> [--scope project|user]               Remove a server",
	"  /mcp reload                                             Reload MCP runtime",
	"  /mcp resources                                          List resources from all servers",
	"  /mcp prompts                                            List prompts from all servers",
	"  /mcp test <name>                                        Test connection to a server",
	"  /mcp reauth <name>                                      Reauthorize OAuth for a server (opens browser)",
	"  /mcp add <name> [--scope project|user] [--url <url>]    Add a server (non-interactive)",
	"  /mcp add <name> [-- <command...>]                       Add a stdio server",
	"  /mcp smithery-search <kw> [--scope project|user]        Search Smithery registry",
	"  /mcp help                                               Show this help",
].join("\n");

const TUI_ONLY_MCP_VERBS = new Set(["unauth", "smithery-login", "smithery-logout", "reconnect"]);

/** ACP/text-mode `/mcp` handler. Shared by both dispatchers via the spec. */
export async function handleMcpAcp(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const { verb, rest } = parseSubcommand(command.args);
	if (!verb || verb === "help") {
		await runtime.output(MCP_HELP_TEXT);
		return commandConsumed();
	}
	if (verb === "notifications") {
		return usage(
			"MCP notifications require the TUI client (live MCPManager). Use /mcp list to see server status.",
			runtime,
		);
	}
	if (TUI_ONLY_MCP_VERBS.has(verb)) {
		return usage(`/mcp ${verb} requires OAuth or browser flows only available in the TUI client.`, runtime);
	}
	switch (verb) {
		case "resources":
			return await handleResourcesCommand(runtime);
		case "prompts":
			return await handlePromptsCommand(runtime);
		case "test":
			return await handleTestCommand(rest, runtime);
		case "reauth":
			return await handleReauthCommand(rest, runtime);
		case "add":
			return await handleAddCommand(rest, runtime);
		case "smithery-search":
			return await handleSmitherySearchCommand(rest, runtime);
		case "reload":
			await runtime.refreshCommands();
			await runtime.output("MCP runtime reload requested.");
			return commandConsumed();
		case "list":
			return await handleListCommand(runtime);
		case "enable":
		case "disable":
			return await handleEnableDisableCommand(verb, rest, runtime);
		case "remove":
		case "rm":
			return await handleRemoveCommand(rest, runtime);
		default:
			return usage(`Unknown /mcp subcommand: ${verb}. Use /mcp help for available subcommands.`, runtime);
	}
}
