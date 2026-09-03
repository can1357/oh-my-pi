/**
 * `/login grokbot` — instruct the user to install host secrets from inside the
 * Grok Bot system. Not Cursor OAuth and not xAI / Grok CLI login.
 */
import { prompt, shortenPath } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { grokbotSecretsPath, loadGrokbotConfig } from "../providers/grokbot/auth";
import hostInstallPrompt from "../providers/grokbot/host-install-prompt.md" with { type: "text" };
import type { OAuthController } from "./oauth/types";

export { hostInstallPrompt as GROKBOT_HOST_INSTALL_PROMPT };

/**
 * Show the host-install prompt for use **inside** the Grok Bot system, wait
 * for Enter, then verify `secrets/grokbot.env` (or env) has renewer + machine id.
 * Returns `""` so AuthStorage does not duplicate secrets; availability comes
 * from the grokbot env hook (`resolveGrokbotEnvApiKey`).
 */
export async function loginGrokbot(options: OAuthController): Promise<string> {
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

/** Auth-engine login hook (`login "custom" hook="grokbot"`). */
export async function loginGrokbotHook(callbacks: OAuthController): Promise<string> {
	return loginGrokbot(callbacks);
}
