import * as AIError from "../error";
import { resolveUsageReserve, type UsageReserve } from "./reserve";
import type {
	AuthAccountPolicies,
	AuthAccountPolicy,
	AuthAccountSelector,
	AuthAccountWindowPolicy,
	AuthCredential,
	OAuthAccountIdentity,
	OAuthCredential,
} from "./types";
import { DEFAULT_USAGE_RESERVE_PCT, DEFAULT_USAGE_RESERVE_TAPER_HOURS } from "./types";

/** Whether every identity field set on `selector` matches `identity`. */
export function matchesAuthAccountSelector(selector: AuthAccountSelector, identity: OAuthAccountIdentity): boolean {
	return (
		(selector.email === undefined || selector.email === identity.email) &&
		(selector.accountId === undefined || selector.accountId === identity.accountId) &&
		(selector.projectId === undefined || selector.projectId === identity.projectId) &&
		(selector.orgId === undefined || selector.orgId === identity.orgId)
	);
}

/** Validated per-account routing policies (priority/reserve/taper) plus the global reserve fallbacks. */
export class AccountPolicies {
	#accountPolicies: AuthAccountPolicies;
	#defaultReservePct: number;
	#defaultReserveTaperHours: number;

	constructor(
		policies: AuthAccountPolicies,
		defaultReservePct: number | undefined,
		defaultReserveTaperHours?: number,
	) {
		AccountPolicies.#validateAccountPolicyConfiguration(policies);
		this.#accountPolicies = policies;
		this.#defaultReservePct =
			typeof defaultReservePct === "number" && Number.isFinite(defaultReservePct)
				? Math.max(0, Math.min(100, defaultReservePct))
				: DEFAULT_USAGE_RESERVE_PCT;
		this.#defaultReserveTaperHours =
			typeof defaultReserveTaperHours === "number" && Number.isFinite(defaultReserveTaperHours)
				? Math.max(0, defaultReserveTaperHours)
				: DEFAULT_USAGE_RESERVE_TAPER_HOURS;
	}

	/** Global usage reserve (0–100) for accounts without a per-account `reservePct`. */
	get defaultReservePct(): number {
		return this.#defaultReservePct;
	}

	/** Global reserve taper (hours before reset, 0 = static) for accounts without a per-account `taperHours`. */
	get defaultReserveTaperHours(): number {
		return this.#defaultReserveTaperHours;
	}

	/**
	 * Replace the policy set and global reserve in place (live settings change).
	 * Validates the configuration and every provider in `storedCredentials` before
	 * committing; on error the previous policies stay active.
	 */
	replace(
		policies: AuthAccountPolicies,
		defaultReservePct: number | undefined,
		defaultReserveTaperHours: number | undefined,
		storedCredentials: ReadonlyMap<string, readonly AuthCredential[]> = new Map(),
	): void {
		const next = new AccountPolicies(policies, defaultReservePct, defaultReserveTaperHours);
		for (const [provider, credentials] of storedCredentials) next.validateFor(provider, credentials);
		this.#accountPolicies = next.#accountPolicies;
		this.#defaultReservePct = next.#defaultReservePct;
		this.#defaultReserveTaperHours = next.#defaultReserveTaperHours;
	}

	static #validateAccountPolicyConfiguration(accountPolicies: AuthAccountPolicies): void {
		for (let index = 0; index < accountPolicies.length; index += 1) {
			const policy = accountPolicies[index]!;
			const path = `auth.accountPolicies[${index}]`;
			if (
				typeof policy.provider !== "string" ||
				policy.provider.length === 0 ||
				policy.provider.trim() !== policy.provider
			) {
				throw new AIError.ConfigurationError(
					`${path}.provider must be a non-empty string without surrounding whitespace`,
				);
			}
			if (!policy.account || typeof policy.account !== "object") {
				throw new AIError.ConfigurationError(`${path}.account must be an object`);
			}
			const baseIdentities = [policy.account.email, policy.account.accountId, policy.account.projectId];
			if (!baseIdentities.some(value => typeof value === "string" && value.length > 0)) {
				throw new AIError.ConfigurationError(
					`${path}.account must include at least one of email, accountId, or projectId`,
				);
			}
			for (const field of ["email", "accountId", "projectId", "orgId"] as const) {
				const value = policy.account[field];
				if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
					throw new AIError.ConfigurationError(`${path}.account.${field} must be a non-empty string`);
				}
			}
			if (policy.priority !== undefined && !Number.isFinite(policy.priority)) {
				throw new AIError.ConfigurationError(`${path}.priority must be a finite number`);
			}
			AccountPolicies.#validateReserveFields(path, policy);
			if (policy.windows === undefined) continue;
			if (!policy.windows || typeof policy.windows !== "object" || Array.isArray(policy.windows)) {
				throw new AIError.ConfigurationError(`${path}.windows must be an object keyed by usage window id`);
			}
			const windowIds = Object.keys(policy.windows);
			if (windowIds.length === 0) {
				throw new AIError.ConfigurationError(`${path}.windows must name at least one usage window`);
			}
			for (const windowId of windowIds) {
				if (windowId.length === 0 || windowId.trim() !== windowId) {
					throw new AIError.ConfigurationError(
						`${path}.windows keys must be usage window ids without surrounding whitespace`,
					);
				}
				const windowPath = `${path}.windows.${windowId}`;
				const override = policy.windows[windowId];
				if (!override || typeof override !== "object") {
					throw new AIError.ConfigurationError(`${windowPath} must be an object`);
				}
				if (override.reservePct === undefined && override.taperHours === undefined) {
					throw new AIError.ConfigurationError(`${windowPath} must set reservePct or taperHours`);
				}
				AccountPolicies.#validateReserveFields(windowPath, override);
			}
		}
	}

	static #validateReserveFields(path: string, fields: AuthAccountWindowPolicy): void {
		if (
			fields.reservePct !== undefined &&
			(!Number.isFinite(fields.reservePct) || fields.reservePct < 0 || fields.reservePct > 100)
		) {
			throw new AIError.ConfigurationError(`${path}.reservePct must be a finite number between 0 and 100`);
		}
		if (fields.taperHours !== undefined && (!Number.isFinite(fields.taperHours) || fields.taperHours < 0)) {
			throw new AIError.ConfigurationError(`${path}.taperHours must be a finite number of at least 0`);
		}
	}

	validateUsageCapability(provider: string, canFetchUsage: boolean): void {
		if (canFetchUsage) return;
		for (const field of ["reservePct", "windows"] as const) {
			const policyIndex = this.#accountPolicies.findIndex(
				policy => policy.provider === provider && policy[field] !== undefined,
			);
			if (policyIndex !== -1) {
				throw new AIError.ConfigurationError(
					`auth.accountPolicies[${policyIndex}].${field} requires a usage provider for ${provider}`,
				);
			}
		}
	}

	validateFor(provider: string, credentials: readonly AuthCredential[]): void {
		const policies = this.#accountPolicies
			.map((policy, index) => ({ policy, index }))
			.filter(({ policy }) => policy.provider === provider);
		if (policies.length === 0) return;
		const oauthCredentials = credentials.filter(
			(credential): credential is OAuthCredential => credential.type === "oauth",
		);
		if (oauthCredentials.length === 0) return;

		const claimedCredentials = new Map<number, number>();
		for (const { policy, index } of policies) {
			const matches: number[] = [];
			for (let credentialIndex = 0; credentialIndex < oauthCredentials.length; credentialIndex += 1) {
				if (matchesAuthAccountSelector(policy.account, oauthCredentials[credentialIndex]!)) {
					matches.push(credentialIndex);
				}
			}
			const path = `auth.accountPolicies[${index}].account`;
			if (matches.length === 0) {
				throw new AIError.ConfigurationError(`${path} matches no stored OAuth account for ${provider}`);
			}
			if (matches.length > 1) {
				throw new AIError.ConfigurationError(
					`${path} matches ${matches.length} stored OAuth accounts for ${provider}; add another identity field`,
				);
			}
			const credentialIndex = matches[0]!;
			const previousPolicyIndex = claimedCredentials.get(credentialIndex);
			if (previousPolicyIndex !== undefined) {
				throw new AIError.ConfigurationError(
					`auth.accountPolicies[${previousPolicyIndex}] and auth.accountPolicies[${index}] match the same stored OAuth account for ${provider}`,
				);
			}
			claimedCredentials.set(credentialIndex, index);
		}
	}

	/**
	 * Return the configured account policy matching an OAuth identity.
	 *
	 * This is a read-only diagnostics surface: it performs the same conjunctive
	 * selector match as routing and never refreshes, ranks, or mutates credentials.
	 */
	find(provider: string, identity: OAuthAccountIdentity): AuthAccountPolicy | undefined {
		return this.#accountPolicies.find(
			policy => policy.provider === provider && matchesAuthAccountSelector(policy.account, identity),
		);
	}

	/** Return the configured policy for a stored OAuth credential. */
	forCredential(provider: string, credential: AuthCredential): AuthAccountPolicy | undefined {
		return credential.type === "oauth" ? this.find(provider, credential) : undefined;
	}

	/**
	 * Resolve the reserve protecting a stored credential: its account's
	 * `reservePct` / `taperHours` win over `fallbackFraction` and the global taper.
	 * `undefined` when neither the account nor the caller supplies a reserve.
	 */
	reserveFor(
		provider: string,
		credential: AuthCredential,
		fallbackFraction: number | undefined,
	): UsageReserve | undefined {
		return resolveUsageReserve(
			this.forCredential(provider, credential),
			fallbackFraction,
			this.#defaultReserveTaperHours,
		);
	}
}
