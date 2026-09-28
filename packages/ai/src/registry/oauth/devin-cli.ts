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

const DEVIN_CLI_CREDENTIALS_PATH = path.join(os.homedir(), ".local/share/devin/credentials.toml");

export async function loginDevinCliHook(_callbacks: OAuthController): Promise<string> {
	let text: string;
	try {
		text = await fs.promises.readFile(DEVIN_CLI_CREDENTIALS_PATH, "utf8");
	} catch {
		throw new AIError.OAuthError(
			`No Devin CLI credentials found at ${DEVIN_CLI_CREDENTIALS_PATH}. Run \`devin auth login\` once, then retry this login.`,
			{ kind: "configuration", provider: "devin-cli" },
		);
	}
	let parsed: { windsurf_api_key?: unknown };
	try {
		parsed = Bun.TOML.parse(text) as { windsurf_api_key?: unknown };
	} catch (error) {
		throw new AIError.OAuthError(
			`Devin CLI credentials at ${DEVIN_CLI_CREDENTIALS_PATH} are not valid TOML: ${error instanceof Error ? error.message : String(error)}`,
			{ kind: "validation", provider: "devin-cli" },
		);
	}
	const key = typeof parsed.windsurf_api_key === "string" ? parsed.windsurf_api_key.trim() : "";
	if (!key) {
		throw new AIError.OAuthError(
			`Devin CLI credentials at ${DEVIN_CLI_CREDENTIALS_PATH} carry no windsurf_api_key. Run \`devin auth login\` once, then retry this login.`,
			{ kind: "validation", provider: "devin-cli" },
		);
	}
	// The key is returned raw: the Windsurf RPCs authenticate with the
	// unprefixed form, and the api_server_url in the file matches the host the
	// devin provider and its usage endpoint already default to.
	return key;
}
