/**
 * `/login grokbot` — instruct the user to install host secrets from inside the
 * Grok Bot system. Not Cursor OAuth and not xAI / Grok CLI login.
 */
import { prompt, shortenPath } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { grokbotSecretsPath, loadGrokbotConfig, resolveGrokbotEnvApiKey } from "../providers/grokbot/auth";
import hostInstallPrompt from "../providers/grokbot/host-install-prompt.md" with { type: "text" };
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export { hostInstallPrompt as GROKBOT_HOST_INSTALL_PROMPT };

/**
 * Show the host-install prompt for use **inside** the Grok Bot system, wait
 * for Enter, then verify `secrets/grokbot.env` (or env) has renewer + machine id.
 * Returns `""` so AuthStorage does not duplicate secrets; availability comes
 * from {@link resolveGrokbotEnvApiKey}.
 */
export async function loginGrokbot(options: OAuthLoginCallbacks): Promise<string> {
	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError("Grok Bot");
	}

	options.onProgress?.(
		"Grok Bot auth is installed from inside the Grok Bot system — not Cursor login, not xAI / Grok CLI.",
	);
	options.onProgress?.("Copy the prompt below into Grok Bot. Do not run it in omp.");

	const secretsDisplay = shortenPath(grokbotSecretsPath());
	await options.onPrompt({
		message: prompt.render(hostInstallPrompt, { secretsPath: secretsDisplay }).trim(),
		placeholder: "(Enter when done)",
		allowEmpty: true,
	});

	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}

	const cfg = await loadGrokbotConfig();
	if (!cfg.renewal || !cfg.machineId) {
		throw new AIError.ConfigurationError(
			`Grok Bot secrets missing after install. Expected renewer + machine id in ${secretsDisplay} (or GROKBOT_* / SAND_INFERENCE_RENEWAL_CREDENTIAL env).`,
		);
	}

	options.onProgress?.(`Host secrets ready at ${secretsDisplay} (renewer + machine id present; values not shown).`);
	return "";
}

/**
 * Grok Bot provider — `grokbot` / `grokbot-sand`.
 *
 * Distinct from:
 * - `cursor` / Cursor CLI (`cursor-agent` AgentService/Run)
 * - `xai` / `xai-oauth` / Grok CLI (xAI API keys or SuperGrok OAuth)
 *
 * Auth is a Grok Bot renewal credential (+ machine id checksum), not Cursor OAuth and not xAI.
 * Usage allowances are independent of Cursor and of xAI / Grok CLI — each has its own quota.
 * `/login grokbot` shows a prompt to run inside the Grok Bot system to write host secrets.
 */
export const grokbotProvider = {
	id: "grokbot",
	name: "Grok Bot (not Cursor, not xAI)",
	envKeys: resolveGrokbotEnvApiKey,
	login: loginGrokbot,
} as const satisfies ProviderDefinition;
