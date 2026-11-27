import * as path from "node:path";
import {
	type DiscoverAuthStorageOptions,
	loadAuthAccountPolicyConfig,
	loadAuthBrokerAccountPool,
	readAuthStoreConfigSnapshot,
	resolveAuthBrokerConfig,
	resolveAuthBrokerSnapshotTtlMs,
	resolveLocalAuthEncryption,
} from "@oh-my-pi/pi-ai/auth-broker/discover";
import type { AuthBrokerAccountPool } from "@oh-my-pi/pi-ai/auth-broker/remote-store";
import { getAgentDbPath, getAuthBrokerSnapshotCachePath, isInteractiveHost } from "@oh-my-pi/pi-utils";
import { cfgAuthAccountPolicies, cfgOperatorUnpausedProviders } from "../config/model-settings";
import { resolveConfigValue } from "../config/resolve-config-value";
import type { Settings } from "../config/settings";
import type { AuthDaemonBinding } from "./auth-daemon-contract";
import { cfgRetryUsageReservePct } from "./settings";

export interface AuthDaemonBindingOptions extends Omit<DiscoverAuthStorageOptions, "agentDir" | "accountPool"> {
	/** `null` explicitly disables filtering instead of reading the caller's pool file. */
	accountPool?: AuthBrokerAccountPool | null;
	snapshotTtlMs?: number;
}

/** A daemon binding carries policy data, not SDK hooks or custom runtime behavior. */
export function requiresLocalAuthOwnership(options: AuthDaemonBindingOptions): boolean {
	const auth = options.authStorageOptions;
	return (
		options.configValueResolver !== undefined ||
		options.onBrokerRetry !== undefined ||
		options.sourceLabel !== undefined ||
		auth?.usageProviderResolver !== undefined ||
		auth?.rankingStrategyResolver !== undefined ||
		auth?.usageFetch !== undefined ||
		auth?.usageRequestTimeoutMs !== undefined ||
		auth?.usageLogger !== undefined ||
		auth?.onCredentialDisabled !== undefined ||
		auth?.refreshOAuthCredential !== undefined ||
		auth?.refreshOAuthCredentialMints !== undefined
	);
}

function serializeAccountPool(
	pool: AuthBrokerAccountPool | null | undefined,
): NonNullable<AuthDaemonBinding["broker"]>["accountPool"] {
	return pool
		? Array.from(pool, ([provider, rule]) =>
				"has" in rule
					? { provider, accounts: [...rule] }
					: {
							provider,
							accounts: rule.accounts === undefined ? undefined : [...rule.accounts],
							apiKeys: rule.apiKeys,
						},
			)
		: [];
}

/** Resolve settings, files and environment on the client before sending a private auth bind frame. */
export async function resolveAuthDaemonBinding(
	settings: Settings,
	options: AuthDaemonBindingOptions = {},
): Promise<AuthDaemonBinding> {
	const agentDir = settings.getAgentDir();
	const configSnapshot = options.configSnapshot ?? readAuthStoreConfigSnapshot(settings.getGlobalSettings());
	const brokerConfig = await resolveAuthBrokerConfig({
		agentDir,
		configSnapshot,
		configValueResolver: options.configValueResolver ?? resolveConfigValue,
	});
	const { accountPolicies, defaultReservePct } = await loadAuthAccountPolicyConfig({
		accountPolicies: options.accountPolicies ?? cfgAuthAccountPolicies.get(settings),
		usageReservePct: options.authStorageOptions?.defaultReservePct ?? cfgRetryUsageReservePct.get(settings),
	});
	const broker =
		brokerConfig === null
			? null
			: {
					...brokerConfig,
					cachePath: path.resolve(options.cachePath ?? getAuthBrokerSnapshotCachePath()),
					ttlMs: options.snapshotTtlMs ?? resolveAuthBrokerSnapshotTtlMs(),
					accountPool: serializeAccountPool(
						options.accountPool === undefined ? await loadAuthBrokerAccountPool() : options.accountPool,
					),
				};
	return {
		dbPath: path.resolve(getAgentDbPath(agentDir)),
		encrypt: await resolveLocalAuthEncryption({ agentDir, configSnapshot }),
		broker,
		retryUnreachableBroker: options.retryUnreachableBroker ?? !isInteractiveHost(),
		accountPolicies,
		defaultReservePct: Math.max(0, Math.min(100, defaultReservePct)),
		unpausedProviders: [...cfgOperatorUnpausedProviders.get(settings)],
	};
}
