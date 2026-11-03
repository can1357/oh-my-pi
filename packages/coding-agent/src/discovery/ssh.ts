/**
 * SSH JSON Provider
 *
 * Discovers SSH hosts from managed omp config paths and legacy root ssh.json files.
 * Priority: 5 (low, project/user config discovery)
 */
import * as path from "node:path";
import { getSSHConfigPath, tryParseJson } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type SSHHost, sshCapability } from "../capability/ssh";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";
import { expandTilde } from "../tools/path-utils";
import { createSourceMeta, expandEnvVarsDeep } from "./helpers";

const PROVIDER_ID = "ssh-json";
const DISPLAY_NAME = "SSH Config";

interface SSHConfigFile {
	hosts?: Record<
		string,
		{
			host?: string;
			username?: string;
			port?: number | string;
			compat?: boolean | string;
			key?: string;
			keyPath?: string;
			description?: string;
		}
	>;
}

function parsePort(value: number | string | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function parseCompat(value: boolean | string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	const normalized = value.trim().toLowerCase();
	if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
	if (normalized === "false" || normalized === "0" || normalized === "no") return false;
	return undefined;
}

function normalizeHost(
	name: string,
	raw: NonNullable<SSHConfigFile["hosts"]>[string],
	source: SourceMeta,
	home: string,
	warnings: string[],
): SSHHost | null {
	if (!raw.host) {
		warnings.push(`Missing host for SSH entry: ${name}`);
		return null;
	}

	const port = parsePort(raw.port);
	if (raw.port !== undefined && port === undefined) {
		warnings.push(`Invalid port for SSH entry ${name}: ${String(raw.port)}`);
	}

	const compat = parseCompat(raw.compat);
	if (raw.compat !== undefined && compat === undefined) {
		warnings.push(`Invalid compat flag for SSH entry ${name}: ${String(raw.compat)}`);
	}

	const keyValue = raw.keyPath ?? raw.key;
	const keyPath = keyValue ? expandTilde(keyValue, home) : undefined;

	return {
		name,
		host: raw.host,
		username: raw.username,
		port,
		keyPath,
		description: raw.description,
		compat,
		_source: source,
	};
}

async function loadSshJsonFile(
	ctx: LoadContext,
	filePath: string,
	level: "user" | "project",
): Promise<LoadResult<SSHHost>> {
	const items: SSHHost[] = [];
	const warnings: string[] = [];
	const content = await readFile(filePath);
	if (content === null) {
		return { items, warnings };
	}
	const parsed = tryParseJson<SSHConfigFile>(content);
	if (!parsed) {
		warnings.push(`Failed to parse JSON in ${filePath}`);
		return { items, warnings };
	}
	const config = expandEnvVarsDeep(parsed);
	if (!config.hosts || typeof config.hosts !== "object") {
		warnings.push(`Missing hosts in ${filePath}`);
		return { items, warnings };
	}

	const source = createSourceMeta(PROVIDER_ID, filePath, level);
	for (const [name, rawHost] of Object.entries(config.hosts)) {
		if (!name.trim()) {
			warnings.push(`Invalid SSH host name in ${filePath}`);
			continue;
		}
		if (!rawHost || typeof rawHost !== "object") {
			warnings.push(`Invalid host entry in ${filePath}: ${name}`);
			continue;
		}
		const host = normalizeHost(name, rawHost, source, ctx.home, warnings);
		if (host) items.push(host);
	}

	return {
		items,
		warnings: warnings.length > 0 ? warnings : undefined,
	};
}
async function load(ctx: LoadContext): Promise<LoadResult<SSHHost>> {
	const candidateSources: Array<{ path: string; level: "user" | "project" }> = [
		{ path: getSSHConfigPath("project", ctx.cwd), level: "project" },
		{ path: getSSHConfigPath("user", ctx.cwd), level: "user" },
		{ path: path.join(ctx.cwd, "ssh.json"), level: "project" },
		{ path: path.join(ctx.cwd, ".ssh.json"), level: "project" },
	];
	const uniqueSources = candidateSources.filter(
		(source, index, arr) => arr.findIndex(candidate => candidate.path === source.path) === index,
	);
	const results = await Promise.all(uniqueSources.map(source => loadSshJsonFile(ctx, source.path, source.level)));
	const allItems = results.flatMap(r => r.items);
	const allWarnings = results.flatMap(r => r.warnings ?? []);
	return {
		items: allItems,
		warnings: allWarnings.length > 0 ? allWarnings : undefined,
	};
}

registerProvider(sshCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load SSH hosts from managed omp paths and legacy ssh.json/.ssh.json files",
	priority: 5,
	load,
});
