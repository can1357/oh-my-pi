/**
 * `login "custom" hook="devin-cli"`: adopts the Windsurf seat key the official
 * Devin CLI persists in `credentials.toml` as a stored `devin` API key. Never
 * prompts and never touches the network.
 */
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import { isRecord } from "../../utils";

// Hosts verified to accept the same raw seat key (#13116). The key is sent to
// the provider's default host, so a CLI bound elsewhere must not be adopted.
const KNOWN_API_HOSTS = ["server.codeium.com", "server.enterprise.windsurf.com"];

/** Candidate credential files in probe order: Windows APPDATA, XDG, `~/.local/share`, then the macOS Library. */
export function devinCliCredentialPaths(
	homedir = os.homedir(),
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string[] {
	const win = platform === "win32";
	const p = win ? path.win32 : path.posix;
	const dataDirs = [
		win ? env.APPDATA : undefined,
		env.XDG_DATA_HOME,
		p.join(homedir, ".local", "share"),
		win ? undefined : p.join(homedir, "Library", "Application Support"),
	];
	const files = dataDirs.filter((dir): dir is string => !!dir).map(dir => p.join(dir, "devin", "credentials.toml"));
	return [...new Set(files)];
}

/** Returns the seat key from the first existing candidate; missing files are skipped, any other failure surfaces. */
export async function readDevinCliCredentials(candidates: readonly string[]): Promise<string> {
	for (const file of candidates) {
		let text: string;
		try {
			text = await Bun.file(file).text();
		} catch (error) {
			if (isEnoent(error)) continue;
			throw invalid(`Cannot read Devin CLI credentials at ${file}`, error);
		}
		return parseCredentials(text, file);
	}
	throw new AIError.OAuthError(
		`No Devin CLI credentials found (probed: ${candidates.join(", ")}). Run \`devin auth login\`, then retry.`,
		{ kind: "configuration", provider: "devin-cli" },
	);
}

export function loginDevinCliHook(): Promise<string> {
	return readDevinCliCredentials(devinCliCredentialPaths());
}

function parseCredentials(text: string, file: string): string {
	let parsed: unknown;
	try {
		parsed = Bun.TOML.parse(text);
	} catch (error) {
		throw invalid(`Devin CLI credentials at ${file} are not valid TOML`, error);
	}
	const record: Record<string, unknown> = isRecord(parsed) ? parsed : {};
	const key = typeof record.windsurf_api_key === "string" ? record.windsurf_api_key.trim() : "";
	if (!key) {
		throw invalid(`Devin CLI credentials at ${file} have no windsurf_api_key. Run \`devin auth login\`, then retry.`);
	}
	const serverUrl = record.api_server_url;
	if (typeof serverUrl === "string" && serverUrl) {
		const host = URL.parse(serverUrl)?.host;
		if (!host || !KNOWN_API_HOSTS.includes(host)) {
			throw invalid(
				`Devin CLI credentials at ${file} point at unsupported API server "${serverUrl}" (supported: ${KNOWN_API_HOSTS.join(", ")}).`,
			);
		}
	}
	return key;
}

function invalid(message: string, cause?: unknown): AIError.OAuthError {
	const detail = cause instanceof Error ? `: ${cause.message}` : "";
	return new AIError.OAuthError(`${message}${detail}`, { kind: "validation", provider: "devin-cli", cause });
}
