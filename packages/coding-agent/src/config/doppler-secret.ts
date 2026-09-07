import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse } from "yaml";
import { $envExact } from "@oh-my-pi/pi-utils";

export interface DopplerSecretsGetRef {
	secretName: string;
	project: string;
	config: string;
}

const DOPPLER_API_HOST = "https://api.doppler.com";

/** Parse `doppler secrets get NAME -p PROJECT -c CONFIG ...` shell commands. */
export function parseDopplerSecretsGetCommand(command: string): DopplerSecretsGetRef | undefined {
	const trimmed = command.trim();
	const nameMatch = trimmed.match(/^doppler\s+secrets\s+get\s+(\S+)/);
	if (!nameMatch) return undefined;
	const projectMatch = trimmed.match(/(?:^|\s)-p\s+(\S+)/);
	const configMatch = trimmed.match(/(?:^|\s)-c\s+(\S+)/);
	if (!projectMatch || !configMatch) return undefined;
	return {
		secretName: nameMatch[1],
		project: projectMatch[1],
		config: configMatch[1],
	};
}

function readScopedDopplerTokens(configDir: string): Record<string, string> {
	const configPath = path.join(configDir, ".doppler.yaml");
	if (!fs.existsSync(configPath)) return {};
	try {
		const parsed = parse(fs.readFileSync(configPath, "utf8")) as {
			scoped?: Record<string, { token?: string }>;
		};
		const scoped = parsed.scoped;
		if (!scoped || typeof scoped !== "object") return {};
		const tokens: Record<string, string> = {};
		for (const [scope, entry] of Object.entries(scoped)) {
			if (typeof entry?.token === "string" && entry.token.length > 0) tokens[scope] = entry.token;
		}
		return tokens;
	} catch {
		return {};
	}
}

function pickScopedDopplerToken(tokens: Record<string, string>, cwd: string): string | undefined {
	const normalized = path.resolve(cwd);
	const matches: Array<{ scope: string; token: string; apiToken: boolean }> = [];
	for (const [scope, token] of Object.entries(tokens)) {
		const resolvedScope = scope === "/" ? "/" : path.resolve(scope);
		if (
			resolvedScope === "/" ||
			normalized === resolvedScope ||
			normalized.startsWith(`${resolvedScope}${path.sep}`)
		) {
			matches.push({ scope: resolvedScope, token, apiToken: token.startsWith("dp.ct.") });
		}
	}
	if (matches.length === 0) return undefined;
	matches.sort((a, b) => {
		if (a.apiToken !== b.apiToken) return a.apiToken ? -1 : 1;
		return b.scope.length - a.scope.length;
	});
	return matches[0].token;
}

/** Resolve a Doppler bearer token without invoking the CLI (avoids headless keyring). */
export function resolveDopplerToken(
	cwd: string,
	configDir?: string,
	tokensOverride?: Record<string, string>,
): string | undefined {
	const envToken = $envExact("DOPPLER_TOKEN");
	if (envToken) return envToken;
	const tokens = tokensOverride ?? readScopedDopplerTokens(configDir ?? path.join(os.homedir(), ".doppler"));
	return pickScopedDopplerToken(tokens, cwd);
}

function extractDopplerSecretValue(payload: unknown, secretName: string): string | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const entry = Reflect.get(payload, secretName);
	if (typeof entry === "string") {
		const trimmed = entry.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	if (!entry || typeof entry !== "object") return undefined;
	const computed = Reflect.get(entry, "computed");
	if (typeof computed === "string") {
		const trimmed = computed.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	const raw = Reflect.get(entry, "raw");
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	return undefined;
}

export async function fetchDopplerSecretViaApi(
	ref: DopplerSecretsGetRef,
	token: string,
	fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
	const url = new URL("/v3/configs/config/secrets/download", DOPPLER_API_HOST);
	url.searchParams.set("project", ref.project);
	url.searchParams.set("config", ref.config);
	url.searchParams.set("format", "json");
	const response = await fetchImpl(url, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!response.ok) return undefined;
	const payload = await response.json();
	return extractDopplerSecretValue(payload, ref.secretName);
}

/** Headless-safe resolution for models.yml `!doppler secrets get …` commands. */
export async function resolveDopplerSecretsGetCommand(
	command: string,
	cwd: string,
	fetchImpl?: typeof fetch,
	configDir?: string,
): Promise<string | undefined> {
	const ref = parseDopplerSecretsGetCommand(command);
	if (!ref) return undefined;
	const token = resolveDopplerToken(cwd, configDir);
	if (!token) return undefined;
	return await fetchDopplerSecretViaApi(ref, token, fetchImpl);
}

/** Sync variant used by {@link model-config-values}. */
export function resolveDopplerSecretsGetCommandSync(
	command: string,
	cwd: string,
	timeoutMs: number,
	configDir?: string,
): string | undefined {
	const ref = parseDopplerSecretsGetCommand(command);
	if (!ref) return undefined;
	const token = resolveDopplerToken(cwd, configDir);
	if (!token) return undefined;
	const url = new URL("/v3/configs/config/secrets/download", DOPPLER_API_HOST);
	url.searchParams.set("project", ref.project);
	url.searchParams.set("config", ref.config);
	url.searchParams.set("format", "json");
	const script = `const r = await fetch(${JSON.stringify(url.toString())}, { headers: { Authorization: 'Bearer ' + process.env.__OMP_DOPPLER_TOKEN } });
if (!r.ok) process.exit(2);
const d = await r.json();
const e = d[${JSON.stringify(ref.secretName)}];
const v = (typeof e === 'string' ? e : e?.computed ?? e?.raw ?? '').trim();
if (!v) process.exit(3);
process.stdout.write(v);`;
	const result = Bun.spawnSync({
		cmd: [process.execPath, "--eval", script],
		env: { ...process.env, __OMP_DOPPLER_TOKEN: token },
		stdout: "pipe",
		stderr: "pipe",
		timeout: timeoutMs,
	});
	if (result.exitCode !== 0) return undefined;
	const stdout = result.stdout?.toString().trim();
	return stdout && stdout.length > 0 ? stdout : undefined;
}
