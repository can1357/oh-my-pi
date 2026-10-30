/**
 * `omp login [provider]` — the terminal counterpart of the in-session `/login`.
 *
 * Authenticates against the same credential store sessions read (local
 * `agent.db`, or the configured auth broker), including OAuth providers
 * contributed by extensions, then re-runs that provider's model discovery so
 * the next session sees the models the credential unlocked.
 */
import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import * as readline from "node:readline";
import { getOAuthProviders } from "@oh-my-pi/pi-ai";
import { APP_NAME, getAgentDbPath, getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import { resolveAuthBrokerConfig } from "../session/auth-broker-config";
import { formatLoginIdentity, pickOAuthProvider, runTerminalOAuthLogin } from "./oauth-terminal";

/**
 * Log in to `provider`, or to one picked interactively when omitted.
 *
 * An unknown/unavailable provider, a cancelled selection or prompt, and a
 * failed OAuth flow print `Login failed: …` to stderr and set exit code 1.
 */
export async function runLoginCommand(provider: string | undefined): Promise<void> {
	const cwd = getProjectDir();
	const settings = await Settings.init({ cwd });
	const authStorage = await discoverAuthStorage(undefined, { settings });
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		const modelRegistry = new ModelRegistry(authStorage);
		// Extensions may register OAuth providers; load them so they are listed.
		await loadCliExtensionProviders(modelRegistry, settings, cwd);

		const providers = getOAuthProviders().filter(p => p.available);
		const providerId = provider ?? (await pickOAuthProvider(rl, providers));
		const info = providers.find(p => p.id === providerId);
		if (!info) {
			throw new Error(
				__ompTranslate(
					"Unknown OAuth provider '{0}'. Run `{1} login` to pick one.",
					`${providerId}`,
					`${APP_NAME}`,
				),
			);
		}

		const identity = await runTerminalOAuthLogin(rl, authStorage, info.id, { openBrowser: true });
		if (!identity) {
			process.stdout.write(chalk.yellow(__ompTranslate("No credentials were stored for {0}.\n", `${info.name}`)));
			return;
		}
		// A provider-scoped online refresh re-runs discovery with the new
		// credential; a fresh cache row fetched before login would otherwise hide
		// the unlocked models until its TTL expires (#5780).
		await modelRegistry.refreshProvider(info.storeCredentialsAs ?? info.id, "online");

		const who = formatLoginIdentity(identity);
		process.stdout.write(
			chalk.green(
				__ompTranslate(
					"\nLogged in to {0}{1}\n",
					`${info.name}`,
					`${who ? __ompTranslate(" as {0}", `${who}`) : ""}`,
				),
			),
		);
		const broker = await resolveAuthBrokerConfig();
		process.stdout.write(
			chalk.dim(
				broker
					? __ompTranslate("Credentials saved to auth broker {0}\n", `${broker.url}`)
					: __ompTranslate("Credentials saved to {0}\n", `${getAgentDbPath()}`),
			),
		);
	} catch (error) {
		process.stderr.write(
			chalk.red(__ompTranslate("Login failed: {0}\n", `${error instanceof Error ? error.message : String(error)}`)),
		);
		process.exitCode = 1;
	} finally {
		rl.close();
		authStorage.close();
	}
}
