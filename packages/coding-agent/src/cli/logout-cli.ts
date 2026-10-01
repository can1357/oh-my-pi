/** Terminal logout removes exactly one stored row, without authenticating it first. */
import * as readline from "node:readline";
import { type AuthStorage, getOAuthProviders } from "@oh-my-pi/pi-ai";
import { AuthBrokerCredentialDeleteUnsupportedError } from "@oh-my-pi/pi-ai/auth-broker";
import { formatProviderName } from "@oh-my-pi/pi-tui/chrome/format";
import { getAgentDbPath, getProjectDir, sanitizeText } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import { resolveAuthBrokerConfig } from "../session/auth-broker-config";
import {
	collectLogoutCredentials,
	logoutCredentialLabel,
	type LogoutCredentialSummary,
} from "../slash-commands/helpers/logout";
import { pickIndex, promptLine } from "./oauth-terminal";

export interface LogoutFlowOptions {
	storage: AuthStorage;
	isKnownProvider: (provider: string) => boolean;
	refreshProvider: (provider: string, mode: "online") => Promise<void>;
	/** Maps registered OAuth aliases onto their credential-storage provider. */
	resolveProvider?: (provider: string) => string;
	pickIndex: (title: string, labels: readonly string[]) => Promise<number>;
	promptLine: (question: string) => Promise<string>;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	storageLocation: string;
}

function normalized(value: string): string {
	return value.trim().toLowerCase();
}

function accountLabel(row: LogoutCredentialSummary): string {
	return `${sanitizeText(logoutCredentialLabel(row))} · ${row.type} #${row.id}${row.disabled ? " · disabled" : ""}`;
}

/** Injectable terminal boundary over real storage; returns 0 for cancellation or removal. */
export async function runLogoutFlow(
	provider: string | undefined,
	account: string | undefined,
	options: LogoutFlowOptions,
): Promise<0 | 1> {
	const { storage, stdout, stderr } = options;
	const cancel = (): 0 => {
		stdout("Logout cancelled. No credentials were removed.\n");
		return 0;
	};
	let failure = "Could not load stored credentials.";
	let readingInput = false;
	try {
		// Revalidation reads the local/broker snapshot only; it never refreshes OAuth.
		await storage.credentials.revalidate();
		const inventory = await collectLogoutCredentials(storage);
		const providers = [...new Set(inventory.map(row => row.provider))].sort();
		let selectedProvider: string;
		if (provider === undefined) {
			if (providers.length === 0) {
				stderr("Logout failed: No stored credentials to remove.\n");
				return 1;
			}
			failure = "Could not select a provider.";
			readingInput = true;
			const index = await options.pickIndex(
				"Select a provider to log out:",
				providers.map(id => `${formatProviderName(id)} (${sanitizeText(id)})`),
			);
			readingInput = false;
			selectedProvider = providers[index];
		} else {
			const requested = normalized(provider);
			if (!requested) {
				stderr("Logout failed: Provider must not be empty.\n");
				return 1;
			}
			const resolved = normalized(options.resolveProvider?.(requested) ?? requested);
			selectedProvider = providers.find(id => normalized(id) === resolved) ?? resolved;
			if (!providers.includes(selectedProvider) && !options.isKnownProvider(selectedProvider)) {
				stderr("Logout failed: Unknown provider. Run `omp logout` to select a stored provider.\n");
				return 1;
			}
		}

		const rows = inventory.filter(row => row.provider === selectedProvider);
		if (rows.length === 0) {
			stderr(`Logout failed: No stored credentials for ${sanitizeText(selectedProvider)}.\n`);
			const source = storage.keys.describe(selectedProvider);
			if (source) stdout(`Remaining authentication source: ${sanitizeText(source)} (not removed).\n`);
			return 1;
		}

		let selected: LogoutCredentialSummary;
		if (account === undefined) {
			failure = "Could not select an account.";
			readingInput = true;
			const index = await options.pickIndex(
				`Select a stored account for ${sanitizeText(selectedProvider)}:`,
				rows.map(accountLabel),
			);
			readingInput = false;
			selected = rows[index];
		} else {
			const selector = normalized(account);
			const matches = /^\d+$/.test(selector)
				? rows.filter(row => String(row.id) === selector)
				: rows.filter(row =>
						[row.email, row.accountId, row.projectId].some(
							value => value !== undefined && normalized(value) === selector,
						),
					);
			if (matches.length === 0) {
				stderr(`Logout failed: No matching stored account for ${sanitizeText(selectedProvider)}.\n`);
				return 1;
			}
			if (matches.length > 1) {
				stderr("Logout failed: Multiple stored accounts match. Specify an exact credential row ID:\n");
				for (const row of matches) stderr(`  ${accountLabel(row)}\n`);
				return 1;
			}
			selected = matches[0];
		}

		failure = "Could not confirm credential removal.";
		readingInput = true;
		const answer = await options.promptLine(
			`Remove ${sanitizeText(selectedProvider)} account ${accountLabel(selected)}? [y/N] `,
		);
		readingInput = false;
		if (!["y", "yes"].includes(normalized(answer))) return cancel();

		failure = "Could not delete the stored credential. No provider refresh was attempted.";
		if (!(await storage.credentials.removeById(selectedProvider, selected.id))) {
			stderr("Logout failed: Selected credential is no longer stored. No provider refresh was attempted.\n");
			return 1;
		}
		stdout(
			`Removed ${sanitizeText(selectedProvider)} account ${accountLabel(selected)} from ${sanitizeText(options.storageLocation)}.\n`,
		);
		let result: 0 | 1 = 0;
		try {
			await options.refreshProvider(selectedProvider, "online");
		} catch {
			stderr("Credential removed, but provider refresh failed.\n");
			result = 1;
		}
		try {
			const source = storage.keys.describe(selectedProvider);
			stdout(`Remaining authentication source: ${source ? sanitizeText(source) : "none"}.\n`);
		} catch {
			stderr("Credential removed, but remaining authentication source could not be determined.\n");
			result = 1;
		}
		return result;
	} catch (error) {
		if (readingInput && error instanceof Error && error.message.startsWith("Login cancelled")) return cancel();
		if (error instanceof AuthBrokerCredentialDeleteUnsupportedError) {
			stderr(
				"Logout failed: This auth broker does not support permanent credential deletion. Update the broker and try again.\n",
			);
			return 1;
		}
		// Storage, extensions and provider failures can contain credential material.
		stderr(`Logout failed: ${failure}\n`);
		return 1;
	}
}

/** Uses the same extension-aware local/broker credential store as terminal login. */
export async function runLogoutCommand(provider: string | undefined, account: string | undefined): Promise<void> {
	let storage: AuthStorage | undefined;
	let rl: readline.Interface | undefined;
	try {
		const cwd = getProjectDir();
		const settings = await Settings.init({ cwd });
		const broker = await resolveAuthBrokerConfig();
		storage = await discoverAuthStorage(undefined, { settings, sourceLabel: broker ? "auth broker" : undefined });
		const registry = new ModelRegistry(storage);
		await loadCliExtensionProviders(registry, settings, cwd);
		const oauthProviders = getOAuthProviders();
		rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		const terminal = rl;
		const code = await runLogoutFlow(provider, account, {
			storage,
			isKnownProvider: id =>
				registry.hasProvider(id) || oauthProviders.some(info => info.id === id || info.storeCredentialsAs === id),
			resolveProvider: id => oauthProviders.find(info => info.id === id)?.storeCredentialsAs ?? id,
			refreshProvider: async (id, mode) => {
				await registry.refreshProvider(id, mode);
				if (registry.getProviderDiscoveryState(id)?.error) throw new Error("Provider model discovery failed.");
			},
			pickIndex: (title, labels) => pickIndex(terminal, title, labels),
			promptLine: question => promptLine(terminal, question),
			stdout: text => process.stdout.write(text),
			stderr: text => process.stderr.write(text),
			storageLocation: broker ? "auth broker" : getAgentDbPath(),
		});
		if (code !== 0) process.exitCode = code;
	} catch {
		process.stderr.write("Logout failed: Could not initialize credential storage or providers.\n");
		process.exitCode = 1;
	} finally {
		rl?.close();
		storage?.close();
	}
}
