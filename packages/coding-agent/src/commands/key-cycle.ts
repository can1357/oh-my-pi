/**
 * Cycle to the next configured API key for a provider.
 */

import { PROVIDER_REGISTRY } from "@oh-my-pi/pi-ai";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Args, Command } from "@oh-my-pi/pi-utils/cli";
import { keyCycleHelp as commandHelp } from "../cli/command-help";
import { ModelRegistry } from "../config/model-registry";
import { isManagedMCPOAuthCredentialId } from "../mcp/oauth-flow";
import { discoverAuthStorage } from "../sdk";

export default class KeyCycle extends Command {
	static description = commandHelp.description;
	static args = {
		provider: Args.string({
			description: "Provider ID (e.g. anthropic, openai)",
			required: true,
		}),
	};

	static examples = ["# Cycle to the next API key for a custom provider\n  omp key-cycle custom-proxy"];

	async run(): Promise<void> {
		const { args } = await this.parse(KeyCycle);
		const providerName = args.provider ?? "";
		const managedMcpOAuth = isManagedMCPOAuthCredentialId(args.provider);
		const provider = managedMcpOAuth ? providerName : providerName.toLowerCase();

		const authStorage = await discoverAuthStorage();
		try {
			const modelRegistry = new ModelRegistry(authStorage);
			if (modelRegistry.cycleProviderApiKey(provider)) {
				const position = modelRegistry.getProviderApiKeyPosition(provider);
				const where = position ? `key ${position.index + 1}/${position.total}` : "next key";
				const source = authStorage.describeCredentialSource(provider);
				// Masked result only: the position and credential provenance, never key material.
				process.stdout.write(`Cycled provider "${providerName}" to ${where}${source ? ` (${source})` : ""}.\n`);
				return;
			}
			const position = modelRegistry.getProviderApiKeyPosition(provider);
			if (position ?? authStorage.hasAuth(provider)) {
				process.stdout.write(`Provider "${providerName}" has a single configured API key; nothing to cycle.\n`);
				return;
			}
			// Find all active/configured providers (mirrors the token command).
			const activeProviders = new Set<string>();
			for (const p of PROVIDER_REGISTRY) {
				if (authStorage.hasAuth(p.id)) {
					activeProviders.add(p.id);
				}
			}
			const all = authStorage.getAll();
			for (const p in all) {
				if (authStorage.hasAuth(p)) {
					activeProviders.add(p);
				}
			}

			process.stderr.write(`${chalk.red(`No API key list configured for provider "${providerName}".`)}\n`);
			if (activeProviders.size > 0) {
				process.stderr.write(`Configured providers: ${Array.from(activeProviders).sort().join(", ")}\n`);
			}
			process.exitCode = 1;
		} finally {
			authStorage.close();
		}
	}
}
