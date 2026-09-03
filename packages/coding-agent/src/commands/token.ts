/**
 * Get the API key or OAuth token for a provider.
 */

import { PROVIDER_REGISTRY } from "@oh-my-pi/pi-ai";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { getActiveProfile } from "@oh-my-pi/pi-utils/dirs";
import { tokenHelp as commandHelp } from "../cli/command-help";
import { isAuthenticated, ModelRegistry } from "../config/model-registry";
import { refreshStoredManagedMcpOAuthCredential } from "../mcp/oauth-credentials";
import { isManagedMCPOAuthCredentialId, mcpOAuthCredentialProfile } from "../mcp/oauth-flow";
import { discoverAuthStorage } from "../sdk";
import type { AuthStorage } from "../session/auth-storage";
import { getAvailableAuthMethods } from "../web/search/providers/perplexity-auth";

async function resolveManagedMcpOAuthToken(
	authStorage: AuthStorage,
	provider: string,
	options: { credentialId?: number; forceRefresh?: boolean } = {},
): Promise<string | undefined> {
	const row = authStorage
		.listStoredCredentials(provider)
		.find(
			entry =>
				entry.credential.type === "oauth" &&
				(options.credentialId === undefined || entry.id === options.credentialId),
		);
	if (row?.credential.type !== "oauth") return undefined;
	const before = row.credential;
	const result = await refreshStoredManagedMcpOAuthCredential(authStorage, provider, {
		...options,
		recoverServerUrlFromCredentialId: true,
	});
	const credential = result.credential;
	if (!credential || Date.now() >= credential.expires) return undefined;
	if (
		options.forceRefresh &&
		!result.refreshed &&
		credential.access === before.access &&
		credential.refresh === before.refresh &&
		credential.expires === before.expires
	) {
		return undefined;
	}
	return credential.access;
}

export default class Token extends Command {
	static description = commandHelp.description;
	static args = {
		provider: Args.string({
			description: "Provider ID (e.g. anthropic, openai)",
			required: true,
		}),
	};

	static flags = {
		raw: Flags.boolean({
			description: "Output the raw credential value without parsing nested JSON structures",
			default: false,
		}),
		"force-refresh": Flags.boolean({
			description: "Force refresh the OAuth token even if it has not expired",
			default: false,
		}),
		account: Flags.integer({
			char: "a",
			description: "Select the Nth OAuth account (1-based) in stored order instead of the round-robin default",
		}),
		list: Flags.boolean({
			char: "l",
			description: "List the provider's OAuth accounts (index + identity) and exit",
			default: false,
		}),
	};

	static examples = [
		"# Get API key for Anthropic\n  omp token anthropic",
		"# Get raw Copilot credential JSON\n  omp token github-copilot --raw",
		"# Force refresh and get Gemini CLI token\n  omp token google-gemini-cli --force-refresh",
		"# List Anthropic OAuth accounts\n  omp token anthropic --list",
		"# Get the 2nd Anthropic OAuth account's token\n  omp token anthropic --account 2",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Token);
		const providerName = args.provider ?? "";
		const managedMcpOAuth = isManagedMCPOAuthCredentialId(args.provider);
		const provider = managedMcpOAuth ? providerName : providerName.toLowerCase();
		// Profile-scoped managed ids stay isolated per profile: a shared broker
		// snapshot carries `mcp_oauth:profile:*` rows for every profile, so refuse
		// to read/refresh another profile's row from this one (mirrors
		// removeManagedMcpOAuthCredential). Legacy unscoped ids have no profile.
		if (managedMcpOAuth) {
			const scopedProfile = mcpOAuthCredentialProfile(provider);
			if (scopedProfile !== undefined && scopedProfile !== (getActiveProfile() ?? "default")) {
				process.stderr.write(
					`${chalk.red(`Managed MCP credential "${providerName}" belongs to profile "${scopedProfile}", not the active profile.`)}\n`,
				);
				process.exitCode = 1;
				return;
			}
		}

		const authStorage = await discoverAuthStorage();
		try {
			if (flags.list || flags.account !== undefined) {
				const accounts = authStorage.listOAuthAccounts(provider);
				if (accounts.length === 0) {
					process.stderr.write(`${chalk.red(`No OAuth accounts found for provider "${providerName}".`)}\n`);
					process.stderr.write("--account/--list select among OAuth accounts; this provider has none stored.\n");
					process.exitCode = 1;
					return;
				}
				if (flags.list) {
					for (const acct of accounts) {
						const base =
							acct.email ??
							acct.accountId ??
							acct.projectId ??
							acct.enterpriseUrl ??
							`credential #${acct.credentialId}`;
						const org = acct.orgName ?? acct.orgId;
						const label = org && org !== base ? `${base} (${org})` : base;
						process.stdout.write(`${acct.position + 1}. ${label}\n`);
					}
					return;
				}
				const n = flags.account;
				if (n === undefined || n < 1 || n > accounts.length) {
					process.stderr.write(
						`${chalk.red(`Invalid --account ${n ?? "(missing)"}.`)} Provider "${providerName}" has ${accounts.length} OAuth account(s) (1-${accounts.length}).\n`,
					);
					process.exitCode = 1;
					return;
				}
				const resolution = managedMcpOAuth
					? await resolveManagedMcpOAuthToken(authStorage, provider, {
							credentialId: accounts[n - 1]?.credentialId,
							forceRefresh: flags["force-refresh"],
						})
					: await authStorage.getOAuthAccessAt(provider, n - 1, {
							forceRefresh: flags["force-refresh"],
						});
				if (typeof resolution === "string") {
					process.stdout.write(`${resolution}\n`);
					return;
				}
				if (!resolution?.ok) {
					const reason = resolution && !resolution.ok ? resolution.error : "no OAuth credential available";
					process.stderr.write(
						`${chalk.red(`Could not get token for account ${n} of "${providerName}": ${reason}`)}\n`,
					);
					process.exitCode = 1;
					return;
				}
				process.stdout.write(`${resolution.accessToken}\n`);
				return;
			}

			const modelRegistry = new ModelRegistry(authStorage);

			// Resolve the API key / token
			let apiKey: string | undefined;

			if (provider === "perplexity") {
				const methods = await getAvailableAuthMethods(authStorage, undefined, {
					forceRefresh: flags["force-refresh"],
				});
				const printable = methods.find(m => m.type === "oauth" || m.type === "api_key");
				if (printable) {
					apiKey = printable.type === "oauth" ? printable.access.accessToken : printable.apiKey;
				}
			}

			if (!apiKey && managedMcpOAuth) {
				apiKey = await resolveManagedMcpOAuthToken(authStorage, provider, {
					forceRefresh: flags["force-refresh"],
				});
			} else if (!apiKey) {
				apiKey = await modelRegistry.getApiKeyForProvider(provider, undefined, {
					forceRefresh: flags["force-refresh"],
				});
			}

			if (!isAuthenticated(apiKey)) {
				// Find all active/configured providers
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

				const msg = `No active credential found for provider "${providerName}".`;
				process.stderr.write(`${chalk.red(msg)}\n`);
				if (activeProviders.size > 0) {
					process.stderr.write(`Configured providers: ${Array.from(activeProviders).sort().join(", ")}\n`);
				}
				process.exitCode = 1;
				return;
			}

			if (!flags.raw) {
				try {
					const parsed = JSON.parse(apiKey);
					if (parsed && typeof parsed === "object" && typeof parsed.token === "string") {
						process.stdout.write(`${parsed.token}\n`);
						return;
					}
				} catch {
					// Not a JSON string, print as-is
				}
			}

			process.stdout.write(`${apiKey}\n`);
		} finally {
			authStorage.close();
		}
	}
}
