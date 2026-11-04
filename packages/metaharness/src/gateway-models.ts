import { stringifyYamlConfig } from "@oh-my-pi/pi-utils/yaml-config";

/**
 * Host environment variable the benchmark runners read the gateway bearer from when
 * `--gateway-token` is not given. A command-line argument is visible to every local
 * user in the process list; an environment variable is visible only to its owner.
 */
export const GATEWAY_TOKEN_INPUT_ENV = "METAHARNESS_GATEWAY_TOKEN";

/** The gateway token value that means the gateway runs open (`--no-auth`). */
export const NO_AUTH_TOKEN = "no-auth";

/** Variables the gateway token travels in on the host; none may reach omp's own environment. */
const GATEWAY_TOKEN_VARS = new Set([GATEWAY_TOKEN_INPUT_ENV, "OMP_BENCH_GATEWAY_TOKEN"]);

/** Whether `name` is a variable the gateway token travels in, which `--env` must not forward to omp. */
export function isGatewayTokenVar(name: string): boolean {
	return GATEWAY_TOKEN_VARS.has(name);
}

/**
 * Every gateway token a process knows: `selected` (the one it uses, if any) and the value of
 * each gateway token variable in `env`, its own environment. A token in either variable is a
 * live bearer even when another one is selected, so every check refuses all of them.
 */
export function knownGatewayTokens(env: Record<string, string | undefined>, selected?: string): string[] {
	const tokens = new Set<string>();
	for (const value of [selected, ...[...GATEWAY_TOKEN_VARS].map(name => env[name])]) {
		if (value !== undefined && value.length > 0 && value !== NO_AUTH_TOKEN) tokens.add(value);
	}
	return [...tokens];
}

/**
 * Refuse an environment meant for the omp process (`--env` entries and forwarded
 * `PI_*` variables) that names a gateway token variable or holds any of `tokens`. omp
 * reads the token from its private file; in its environment every process omp
 * starts, the model's own tool calls included, would inherit it, and the container
 * runtime would get it on its command line.
 */
export function refuseGatewayTokenInEnv(env: Record<string, string>, tokens: string | readonly string[]): void {
	for (const name of Object.keys(env)) {
		if (isGatewayTokenVar(name)) {
			throw new Error(
				`${name} names the gateway token, which must not reach omp's environment ` +
					"(omp reads it from its private file); drop the --env entry",
			);
		}
	}
	refuseGatewayTokenIn(env, tokens, "the environment for omp");
}

/**
 * Refuse `value` when any string in it, key or value, holds any of `tokens`. Use it on
 * everything that is stored (a launch request, the runner's config snapshot) or reaches omp
 * as text (settings, agent arguments, environment): the token goes only to omp's private file.
 * The refusal says where the token is but never repeats any of `tokens`: a key holding one is
 * reported as a key, and a location that would still hold one (the caller's `where`, or keys
 * that join into a token) gives way to a fixed text.
 */
export function refuseGatewayTokenIn(value: unknown, tokens: string | readonly string[], where: string): void {
	const live = (typeof tokens === "string" ? [tokens] : tokens).filter(
		token => token.length > 0 && token !== NO_AUTH_TOKEN,
	);
	if (live.length === 0) return;
	const holds = (text: string): boolean => live.some(token => text.includes(token));
	const at = findText(value, holds, where);
	if (at === undefined) return;
	const location = [at, where].find(text => !holds(text)) ?? "a value";
	throw new Error(
		`${location} holds the gateway token, which must not be stored or reach omp except through its private file`,
	);
}

/**
 * Refuse `value` when any string in it names a gateway token variable. Harbor expands
 * `${NAME}` in the agent environment it is given (`--ae`) from its own environment, so
 * such a reference would hand omp the token without the token's bytes ever appearing.
 */
export function refuseGatewayTokenReference(value: unknown, where: string): void {
	for (const name of GATEWAY_TOKEN_VARS) {
		const at = findText(value, text => text.includes(name), where);
		if (at !== undefined) {
			throw new Error(`${at} refers to ${name}, which would hand omp the gateway token`);
		}
	}
}

/** Where in `value` a string, key or value, `holds` text: the path below `at`, or undefined. */
function findText(value: unknown, holds: (text: string) => boolean, at: string): string | undefined {
	if (typeof value === "string") return holds(value) ? at : undefined;
	// A number or boolean is written back out as its decimal or literal text.
	if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
		return holds(String(value)) ? at : undefined;
	}
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			const found = findText(item, holds, `${at}[${index}]`);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	if (value !== null && typeof value === "object") {
		for (const [key, item] of Object.entries(value)) {
			if (holds(key)) return `a key of ${at}`;
			const found = findText(item, holds, `${at}.${key}`);
			if (found !== undefined) return found;
		}
	}
	return undefined;
}

/**
 * Where the guest omp finds the gateway bearer: this path under `$HOME`, mode 0600,
 * written from data (stdin or a file upload), never from shell text.
 * `agent/omp_local.py` uses the same path.
 */
export const GATEWAY_TOKEN_FILE = ".omp/agent/gateway-token";

/**
 * The `models.yml` `apiKey` every gateway provider gets. omp runs an `apiKey` that
 * starts with `!` as a command and uses its output, so this fixed command reads the
 * token file. The token itself is never in `models.yml` (where omp would run it if it
 * started with `!`), in an argument vector, or in omp's environment (where every
 * process omp starts would inherit it). `agent/omp_local.py` uses the same command.
 */
const GATEWAY_TOKEN_API_KEY = `!cat "$HOME/${GATEWAY_TOKEN_FILE}"`;

/**
 * Render a `models.yml` that routes each provider at the host auth gateway.
 * Every key and value goes through the YAML serializer, so provider ids and the URL
 * stay data. The one key that cannot is `<<`: Bun's YAML reader, which omp uses,
 * expands it as a merge key even when quoted, so that provider id is refused.
 * Every other key, checked over YAML and JSON syntax characters, reads back unchanged.
 */
export function gatewayModelsYaml(providers: Iterable<string>, gatewayUrl: string): string {
	const ids = [...new Set(providers)];
	if (ids.includes("<<")) {
		throw new Error('gateway provider id "<<" is the YAML merge key, which omp cannot read as a provider id');
	}
	const entries = Object.fromEntries(
		ids.map(provider => [
			provider,
			{ baseUrl: gatewayUrl, auth: "oauth", transport: "pi-native", apiKey: GATEWAY_TOKEN_API_KEY },
		]),
	);
	return `# Generated by metaharness — auth via host pm2 gateway.\n${stringifyYamlConfig({ providers: entries })}\n`;
}
