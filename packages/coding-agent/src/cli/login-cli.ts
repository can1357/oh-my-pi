/**
 * `omp login [provider]` — the terminal counterpart of the in-session `/login`.
 *
 * Authenticates against the same credential store sessions read (local
 * `agent.db`, or the configured auth broker), including OAuth providers
 * contributed by extensions, then re-runs that provider's model discovery so
 * the next session sees the models the credential unlocked.
 */
import * as readline from "node:readline";
import { getOAuthProviders } from "@oh-my-pi/pi-ai";
import { LoginCancelledError } from "@oh-my-pi/pi-ai/error";
import { APP_NAME, getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { connectedProviderName } from "../modes/view-model/chrome/format";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import { credentialStoreLabel } from "../session/auth-broker-config";
import { formatLoginIdentity, loginFollowUps, pickOAuthProvider, runTerminalOAuthLogin } from "./oauth-terminal";

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
			throw new Error(`Unknown OAuth provider '${providerId}'. Run \`${APP_NAME} login\` to pick one.`);
		}

		const identity = await runTerminalOAuthLogin(rl, authStorage, info.id, { openBrowser: true });
		if (!identity) {
			process.stdout.write(chalk.yellow(`No credentials were stored for ${info.name}.\n`));
			return;
		}
		// A provider-scoped online refresh re-runs discovery with the new
		// credential; a fresh cache row fetched before login would otherwise hide
		// the unlocked models until its TTL expires (#5780).
		await modelRegistry.refreshProvider(info.storeCredentialsAs ?? info.id, "online");

		const who = formatLoginIdentity(identity);
		process.stdout.write(
			chalk.green(`\nLogged in to ${connectedProviderName(info.id, info.name)}${who ? ` as ${who}` : ""}\n`),
		);
		for (const { tone, text } of loginFollowUps(info.id, identity, `\`${APP_NAME} login ${info.id}\``)) {
			process.stdout.write(`${tone === "warning" ? chalk.yellow(text) : chalk.dim(text)}\n`);
		}
		const destination = await credentialStoreLabel(info.storeCredentialsAs ?? info.id);
		process.stdout.write(chalk.dim(`Credentials saved to ${destination}\n`));
	} catch (error) {
		process.exitCode = 1;
		if (error instanceof LoginCancelledError) {
			// Declining the provider's consent screen is a choice, not a failure.
			process.stderr.write(`${error.message}\n`);
			return;
		}
		process.stderr.write(chalk.red(`Login failed: ${error instanceof Error ? error.message : String(error)}\n`));
	} finally {
		rl.close();
		authStorage.close();
	}
}
