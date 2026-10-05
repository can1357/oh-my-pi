/**
 * Devin CLI credential adoption: `login "custom" hook="devin-cli"`.
 *
 * The official Devin CLI persists its Windsurf seat key (raw `sk-ws-01-...`
 * plus the server-directed API host) in `credentials.toml`. This hook imports
 * those credentials as a stored `devin` api-key account so chat, discovery,
 * and usage work from the pool without the `DEVIN_API_KEY` env-var fallback.
 * Never prompts and never touches the network: either the CLI credentials
 * exist or the flow fails with an actionable message.
 */
import { isEnoent } from "@oh-my-pi/pi-utils";
import * as os from "node:os";
import * as path from "node:path";
import * as AIError from "../../error";
import { isRecord } from "../../utils";
import type { OAuthController } from "./types";

const KNOWN_API_HOSTS = new Set(["server.codeium.com", "server.enterprise.windsurf.com"]);

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
	const paths: string[] = [];
	const push = (candidate: string): void => {
		if (!paths.includes(candidate)) paths.push(candidate);
	};
	if (platform === "win32") {
		if (env.APPDATA) push(pathImpl.join(env.APPDATA, "devin", "credentials.toml"));
	}
	if (env.XDG_DATA_HOME) push(pathImpl.join(env.XDG_DATA_HOME, "devin", "credentials.toml"));
	push(pathImpl.join(homedir, ".local", "share", "devin", "credentials.toml"));
	if (platform !== "win32") {
		push(pathImpl.join(homedir, "Library", "Application Support", "devin", "credentials.toml"));
	}
	return paths;
}

export async function loginDevinCliHook(_callbacks: OAuthController): Promise<string> {
	let lastError: unknown;
	for (const candidate of devinCliCredentialPaths()) {
		try {
			return await readDevinCliCredentials(candidate);
		} catch (error) {
			// A present-but-invalid file is the user's real problem; a missing
			// one just means this platform's location does not exist yet.
			lastError = error;
			if (!(error instanceof AIError.OAuthError) || error.kind !== "configuration") throw error;
		}
	}
	throw new AIError.OAuthError(
		`No Devin CLI credentials found (probed: ${devinCliCredentialPaths().join(", ")}). Run \`devin auth login\` once, then retry this login.`,
		{ kind: "configuration", provider: "devin-cli", cause: lastError instanceof Error ? lastError : undefined },
	);
}

/** Parse and validate the CLI credential file at `filePath`. */
export async function readDevinCliCredentials(filePath: string): Promise<string> {
	let text: string;
	try {
		text = await Bun.file(filePath).text();
	} catch (error) {
		if (isEnoent(error)) {
			throw new AIError.OAuthError(
				`No Devin CLI credentials found at ${filePath}. Run \`devin auth login\` once, then retry this login.`,
				{ kind: "configuration", provider: "devin-cli", cause: error instanceof Error ? error : undefined },
			);
		}
		throw new AIError.OAuthError(`Devin CLI credentials at ${filePath} are unreadable: ${String(error)}`, {
			kind: "validation",
			provider: "devin-cli",
			cause: error instanceof Error ? error : undefined,
		});
	}

	let parsed: unknown;
	try {
		parsed = Bun.TOML.parse(text);
	} catch (error) {
		throw new AIError.OAuthError(
			`Devin CLI credentials at ${filePath} are not valid TOML: ${error instanceof Error ? error.message : String(error)}`,
			{ kind: "validation", provider: "devin-cli" },
		);
	}
	if (!isRecord(parsed) || typeof parsed.windsurf_api_key !== "string" || parsed.windsurf_api_key.trim() === "") {
		throw new AIError.OAuthError(
			`Devin CLI credentials at ${filePath} carry no windsurf_api_key. Run \`devin auth login\` once, then retry this login.`,
			{ kind: "validation", provider: "devin-cli" },
		);
	}

	// The key is returned raw: the Windsurf RPCs authenticate with the
	// unprefixed form, and the api_server_url in the file matches the host the
	// devin provider and its usage endpoint already default to.
	const key = parsed.windsurf_api_key.trim();

	if (typeof parsed.api_server_url === "string" && parsed.api_server_url !== "") {
		const host = new URL(parsed.api_server_url).host;
		if (!KNOWN_API_HOSTS.has(host)) {
			throw new AIError.OAuthError(
				`Devin CLI credentials point at unknown API host "${host}" (expected one of: ${[...KNOWN_API_HOSTS].join(", ")}).`,
				{ kind: "validation", provider: "devin-cli" },
			);
		}
	}

	return key;
}
