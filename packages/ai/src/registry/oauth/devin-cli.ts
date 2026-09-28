/**
 * Devin CLI credential adoption: `login "custom" hook="devin-cli"`.
 *
 * The official Devin CLI persists its Windsurf seat key (raw `sk-ws-01-...`
 * plus the server-directed API host) in `~/.local/share/devin/credentials.toml`.
 * This hook imports those credentials as a stored `devin` api-key account so
 * chat, discovery, and usage work from the pool without the `DEVIN_API_KEY`
 * env-var fallback. Never prompts and never touches the network: either the
 * CLI credentials exist or the flow fails with an actionable message.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as AIError from "../../error";
import type { OAuthController } from "./types";

/**
 * Candidate locations of the Devin CLI credential file, in probe order. The
 * CLI keeps its data under the XDG-style `~/.local/share/devin` on Unix
 * (macOS included, even without XDG_DATA_HOME) and under `%APPDATA%\devin` on
 * Windows; the XDG and macOS-Library variants cover alternate configurations.
 */
export function devinCliCredentialPaths(
	homedir = os.homedir(),
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string[] {
	const pathImpl = platform === "win32" ? path.win32 : path;
	const paths = [pathImpl.join(homedir, ".local", "share", "devin", "credentials.toml")];
	const push = (candidate: string): void => {
		if (!paths.includes(candidate)) paths.push(candidate);
	};
	if (platform === "win32") {
		if (env.APPDATA) push(pathImpl.join(env.APPDATA, "devin", "credentials.toml"));
	} else {
		if (env.XDG_DATA_HOME) paths.unshift(pathImpl.join(env.XDG_DATA_HOME, "devin", "credentials.toml"));
		push(pathImpl.join(homedir, "Library", "Application Support", "devin", "credentials.toml"));
	}
	return paths;
}

/**
 * Parse and validate the CLI credential file. Split from the hook so tests can
 * exercise the failure partitions against fixture files instead of `$HOME`.
 */
export function readDevinCliCredentials(filePath: string): string {
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch {
		throw new AIError.OAuthError(
			`No Devin CLI credentials found at ${filePath}. Run \`devin auth login\` once, then retry this login.`,
			{ kind: "configuration", provider: "devin-cli" },
		);
	}
	return parseDevinCliCredentials(filePath, text);
}

function parseDevinCliCredentials(filePath: string, text: string): string {
	let parsed: { windsurf_api_key?: unknown };
	try {
		parsed = Bun.TOML.parse(text) as { windsurf_api_key?: unknown };
	} catch (error) {
		throw new AIError.OAuthError(
			`Devin CLI credentials at ${filePath} are not valid TOML: ${error instanceof Error ? error.message : String(error)}`,
			{ kind: "validation", provider: "devin-cli" },
		);
	}
	const key = typeof parsed.windsurf_api_key === "string" ? parsed.windsurf_api_key.trim() : "";
	if (!key) {
		throw new AIError.OAuthError(
			`Devin CLI credentials at ${filePath} carry no windsurf_api_key. Run \`devin auth login\` once, then retry this login.`,
			{ kind: "validation", provider: "devin-cli" },
		);
	}
	// The key is returned raw: the Windsurf RPCs authenticate with the
	// unprefixed form, and the api_server_url in the file matches the host the
	// devin provider and its usage endpoint already default to.
	return key;
}

export async function loginDevinCliHook(_callbacks: OAuthController): Promise<string> {
	const candidates = devinCliCredentialPaths();
	for (const candidate of candidates) {
		try {
			return readDevinCliCredentials(candidate);
		} catch (error) {
			// A present-but-invalid file is the user's real problem; a missing
			// one just means this platform's location does not exist yet.
			if (!(error instanceof AIError.OAuthError) || error.kind !== "configuration") throw error;
		}
	}
	throw new AIError.OAuthError(
		`No Devin CLI credentials found (probed: ${candidates.join(", ")}). Run \`devin auth login\` once, then retry this login.`,
		{ kind: "configuration", provider: "devin-cli" },
	);
}
