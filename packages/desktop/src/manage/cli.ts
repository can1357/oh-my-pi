import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../rpc/transport";
/**
 * Short-lived `omp <args…>` invocations.
 *
 * None of the RPC protocol's 45 commands touch configuration — no settings, no
 * plugins — so management goes through the CLI. MCP is the exception and does
 * not come through here: `/mcp` is a slash command, so it rides the session. It runs in Rust rather
 * than the webview: granting `shell:allow-execute` would also let the page spawn
 * the long-lived sidecar directly and bypass the relay that owns process
 * lifetime.
 */

export async function ompCli(args: string[]): Promise<string> {
	// Outside a Tauri webview `invoke` is undefined, and the resulting
	// "Cannot read properties of undefined" tells nobody anything. The frontend
	// is routinely opened in a plain browser during development.
	if (!isTauri()) {
		throw new Error(`Not running inside omp Desktop — \`omp ${args.join(" ")}\` needs the Tauri shell.`);
	}
	return invoke<string>("omp_cli", { args });
}

export async function ompCliJson<T>(args: string[]): Promise<T> {
	const raw = await ompCli([...args, "--json"]);
	try {
		return JSON.parse(raw) as T;
	} catch {
		// A non-JSON body is almost always a usage error printed to stdout;
		// surfacing it verbatim beats "Unexpected token o in JSON".
		throw new Error(raw.trim().slice(0, 400) || "omp returned no output");
	}
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ConfigEntry {
	value?: unknown;
	type: "string" | "number" | "boolean" | "enum" | "array" | "record";
	description: string;
}

export type ConfigMap = Record<string, ConfigEntry>;

export function readConfig(): Promise<ConfigMap> {
	return ompCliJson<ConfigMap>(["config", "list"]);
}

export async function writeConfig(key: string, value: string): Promise<void> {
	await ompCli(["config", "set", key, value]);
}

export async function resetConfig(key: string): Promise<void> {
	await ompCli(["config", "reset", key]);
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

export interface PluginEntry {
	scope: string;
	installPath: string;
	version: string;
	installedAt: string;
	lastUpdated: string;
	enabled: boolean;
}

export interface PluginRecord {
	id: string;
	scope: string;
	entries: PluginEntry[];
}

export interface PluginList {
	npm: PluginRecord[];
	marketplace: PluginRecord[];
}

export function readPlugins(): Promise<PluginList> {
	return ompCliJson<PluginList>(["plugin", "list"]);
}

export function pluginAction(
	action: "install" | "uninstall" | "enable" | "disable" | "upgrade" | "doctor",
	target?: string,
	extra: string[] = [],
): Promise<string> {
	return ompCli(["plugin", action, ...(target ? [target] : []), ...extra]);
}
