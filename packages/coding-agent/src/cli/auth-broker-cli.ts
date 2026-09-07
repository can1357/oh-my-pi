/**
 * `omp auth-broker` command handlers.
 *
 * Sub-verbs:
 *   - `serve [--bind=…]` — boots the broker against the local SQLite store.
 *   - `token` / `token --regenerate` — manages the bearer token file.
 *   - `login <provider> [--via=user@host]` — logs into a provider locally, or
 *     via SSH tunnel into a remote broker host.
 *   - `import <file|dir>` — imports CLIProxyAPI-style JSON credentials into
 *     the local SQLite store (typical use: `import ~/.cliproxy/auth`).
 *   - `migrate --from-local [--include-env] [--include-oauth] [--dry-run]` —
 *     uploads local SQLite + env API keys to the broker, skipping anything
 *     the broker already has.
 *   - `status` — health-pings the configured remote broker.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import {
	type AuthCredential,
	AuthStorage,
	type CredentialDisabledEvent,
	getEnvApiKey,
	getOAuthProviders,
	listProvidersWithEnvKey,
	type OAuthCredential,
	type OAuthProvider,
	type OAuthProviderInfo,
	PASTE_CODE_LOGIN_PROVIDERS,
	PROVIDER_REGISTRY,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	canonicalizePlan,
	DEFAULT_AUTH_BROKER_BIND,
	type SubscriptionLookup,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import { refreshOAuthToken } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/oauth/types";
import { $which, APP_NAME, getAgentDbPath, getConfigRootDir, isEnoent, logger, VERSION } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { setTransports as setLoggerTransports } from "@oh-my-pi/pi-utils/logger";
import { $ } from "bun";
import { Settings } from "../config/settings";
import { refreshManagedMcpOAuthCredential } from "../mcp/oauth-credentials";
import { isManagedMCPOAuthCredentialId, mcpOAuthServerUrlFromCredentialId } from "../mcp/oauth-flow";
import { resolveAuthBrokerConfig } from "../session/auth-broker-config";

export type AuthBrokerAction = "serve" | "token" | "login" | "logout" | "status" | "import" | "migrate" | "list";

export interface AuthBrokerCommandArgs {
	action: AuthBrokerAction;
	flags: {
		json?: boolean;
		bind?: string;
		regenerate?: boolean;
		/** `token`/`serve`: operate on the scrape-scoped `/metrics` token. */
		metrics?: boolean;
		via?: string;
		provider?: string;
		dryRun?: boolean;
		/** `login`/`logout`: provider id. `import`: filesystem path. */
		source?: string;
		/** `import`: keep credentials whose JSON had `disabled: true`. */
		includeDisabled?: boolean;
		/** `migrate`: also upload local OAuth (default: api_key only, since OAuth is via cliproxy import). */
		includeOauth?: boolean;
		/** `migrate`: also capture env-var API keys for providers not yet on broker. */
		includeEnv?: boolean;
		/** `migrate`: required `--from-local` source. Reserved for future sources. */
		fromLocal?: boolean;
		/** `serve`: path to the JSON subscription-config file. */
		subscriptionsConfig?: string;
		/**
		 * `serve`: expose the scrape-scoped `GET /metrics` endpoint. Absent means
		 * "not specified" so env and config can still enable it; the flag itself
		 * wins whenever it is passed.
		 */
		enableMetrics?: boolean;
		/**
		 * `serve`: force `/metrics` off. The parser cannot express `false` for a
		 * boolean flag (a present flag is always `true`, and `--enable-metrics=false`
		 * is a usage error), so without this spelling an inherited env/config `true`
		 * could not be overridden from the command line and the documented
		 * flag-over-env-over-config precedence only worked in one direction.
		 */
		noEnableMetrics?: boolean;
	};
}

const ACTIONS: readonly AuthBrokerAction[] = [
	"serve",
	"token",
	"login",
	"logout",
	"import",
	"migrate",
	"status",
	"list",
];

/** Callback ports baked from the per-provider OAuth flow modules. */
const CALLBACK_PORTS: Record<string, number> = Object.fromEntries(
	PROVIDER_REGISTRY.flatMap(provider =>
		provider.callbackPort != null ? [[provider.id, provider.callbackPort] as [string, number]] : [],
	),
);

/** Master bearer token file — authorizes the entire vault. */
function getTokenFilePath(): string {
	return path.join(getConfigRootDir(), "auth-broker.token");
}

/**
 * Scrape-scoped read-only token file. Authorizes ONLY `GET /metrics`, never the
 * vault routes, so a scrape credential is least-privilege and distinct from the
 * master bearer. A fixed path mirroring the master bearer's convention: this
 * file — not a one-shot stdout print — is a stable deterministic source a
 * secrets-staging step can read. Rotation: re-mint (rewrites the file),
 * re-stage, re-converge.
 */
function getMetricsTokenFilePath(): string {
	return path.join(getConfigRootDir(), "auth-broker-metrics.token");
}

async function readTokenFile(file: string): Promise<string | null> {
	try {
		const raw = await Bun.file(file).text();
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

async function writeTokenFile(file: string, token: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	// No trailing newline: the raw file bytes ARE the token value a secrets-staging
	// step stages verbatim.
	await Bun.write(file, token);
	try {
		await fs.chmod(file, 0o600);
	} catch {
		// Best-effort (e.g. Windows).
	}
}

function generateToken(): string {
	return crypto.randomBytes(32).toString("base64url");
}

/** Read-or-mint the token at `file`, persisting a freshly generated one. */
async function ensureTokenFile(file: string): Promise<string> {
	const existing = await readTokenFile(file);
	if (existing) return existing;
	const token = generateToken();
	await writeTokenFile(file, token);
	return token;
}

/** Env var honored by `serve` when `--subscriptions-config` is not passed (flag wins). */
const SUBSCRIPTIONS_ENV = "OMP_AUTH_BROKER_SUBSCRIPTIONS";

/** Env var honored by `serve` when `--enable-metrics` is not passed (flag wins). */
const METRICS_ENABLED_ENV = "OMP_AUTH_BROKER_METRICS";

/** Env var carrying the scrape token value directly. */
const METRICS_TOKEN_ENV = "OMP_AUTH_BROKER_METRICS_TOKEN";

/**
 * Env var pointing at a file holding the scrape token — the shape a k8s secret
 * mount or a systemd credential takes.
 */
const METRICS_TOKEN_FILE_ENV = "OMP_AUTH_BROKER_METRICS_TOKEN_FILE";

/**
 * Strict truthy parse for the enablement env var: only `1` and `true` (any
 * case) enable. Unset, empty, and every other value are false, so a typo or a
 * leftover `OMP_AUTH_BROKER_METRICS=0` never silently opens the endpoint.
 */
function parseMetricsEnv(raw: string | undefined): boolean {
	if (raw === undefined) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true";
}

/**
 * Whether `serve` exposes `GET /metrics`. Off unless an operator asks for it:
 * an existing deployment that changes nothing gains neither the endpoint nor
 * the scrape-token file.
 *
 * Precedence: flag > env > config. `enableMetrics` is only meaningful when
 * explicitly passed, so an absent flag arrives as `undefined` and falls through
 * to the env and config layers; `--enable-metrics` present means enabled.
 */
async function resolveMetricsEnabled(enableMetrics: boolean | undefined): Promise<boolean> {
	if (enableMetrics !== undefined) return enableMetrics;
	const env = process.env[METRICS_ENABLED_ENV];
	if (env !== undefined) return parseMetricsEnv(env);
	try {
		const settings = await Settings.loadReadOnly({ cwd: process.cwd() });
		return settings.get("auth.broker.metrics");
	} catch {
		// Config is the weakest source and the broker must still boot without it;
		// an unreadable or malformed config leaves the endpoint off, matching the
		// default rather than failing the whole service.
		return false;
	}
}

/**
 * The scrape token for `GET /metrics`, in precedence order: the literal env
 * value, then a file the env points at, then the mint-to-disk file.
 *
 * A provisioned token never touches disk — the injecting env vars exist so a
 * secret can live only in the orchestrator, so minting alongside one would
 * write the operator a second copy they did not ask for.
 *
 * Setting both injection vars is rejected rather than resolved: the two would
 * disagree on rotation, and silently preferring one leaves an operator staging
 * a value the broker is not accepting.
 */
async function resolveMetricsToken(): Promise<{ token: string; source: string }> {
	const literal = process.env[METRICS_TOKEN_ENV];
	const file = process.env[METRICS_TOKEN_FILE_ENV];
	if (literal !== undefined && literal.length > 0 && file !== undefined && file.length > 0) {
		throw new Error(
			`Set only one of ${METRICS_TOKEN_ENV} or ${METRICS_TOKEN_FILE_ENV} (both are set; they would disagree on rotation)`,
		);
	}
	if (literal !== undefined && literal.length > 0) {
		// `isAuthorized()` trims the bearer value out of the Authorization header
		// before comparing, so an injected token carrying a stray newline (common
		// when a file-backed secret is piped into the environment) would never
		// match and every scrape would 401. Trim to the same shape the file path
		// already uses, and reject a whitespace-only value rather than storing an
		// empty token that silently disables auth.
		const token = literal.trim();
		if (token.length === 0) throw new Error(`${METRICS_TOKEN_ENV} is set but contains only whitespace`);
		return { token, source: METRICS_TOKEN_ENV };
	}
	if (file !== undefined && file.length > 0) {
		// A mounted secret almost always ends in a newline, which is not part of
		// the bearer value.
		const token = (await Bun.file(file).text()).trim();
		if (token.length === 0) throw new Error(`${METRICS_TOKEN_FILE_ENV} points at an empty file: ${file}`);
		return { token, source: file };
	}
	const mintPath = getMetricsTokenFilePath();
	return { token: await ensureTokenFile(mintPath), source: mintPath };
}

/**
 * What `serve` should do about `/metrics`. A discriminated union so a disabled
 * broker has no token to accidentally wire up: the token only exists on the
 * enabled arm.
 */
export type ServeMetricsDecision = { enabled: false } | { enabled: true; token: string; source: string };

/**
 * The whole `/metrics` decision for `serve`. Resolving enablement first is the
 * load-bearing ordering: when the endpoint is off this returns before touching
 * the scrape token, so no file is minted and nothing new appears on disk for a
 * deployment that simply upgraded.
 */
export async function resolveServeMetrics(enableMetrics: boolean | undefined): Promise<ServeMetricsDecision> {
	if (!(await resolveMetricsEnabled(enableMetrics))) return { enabled: false };
	const { token, source } = await resolveMetricsToken();
	return { enabled: true, token, source };
}

/**
 * Collapse the `--enable-metrics` / `--no-enable-metrics` pair into the tri-state
 * {@link resolveMetricsEnabled} expects: `true`, `false`, or `undefined` to defer
 * to env then config. Both flags together is operator error with two opposite
 * readings, so it is rejected rather than silently resolved.
 */
export function resolveEnableMetricsFlag(
	enableMetrics: boolean | undefined,
	noEnableMetrics: boolean | undefined,
): boolean | undefined {
	if (enableMetrics === true && noEnableMetrics === true) {
		throw new Error("--enable-metrics and --no-enable-metrics cannot be used together");
	}
	if (noEnableMetrics === true) return false;
	return enableMetrics;
}

/**
 * On-disk JSON shape for the subscription config. `accounts` is keyed by the
 * opaque provider accountId (`accountLabelOf`); `plans` by
 * `"<provider>:<canonical-plan>"`. `renewsAt` is an ISO `YYYY-MM-DD` date the
 * loader converts to unix seconds before it reaches the renderer.
 *
 * One account id can hold subscriptions in several organizations. The
 * account-level `plan`/`renewsAt` describe the account's `org` scope (or the
 * org-less fallback when `org` is absent); the optional `orgs` map carries the
 * remaining org scopes, each keyed by its organization id with its own
 * `plan`/`renewsAt`. A single JSON property per account id cannot represent the
 * same account in two orgs, so the extra scopes live inside `orgs` rather than
 * as duplicate top-level keys.
 */
interface SubscriptionsConfigFile {
	accounts?: Record<string, { provider?: unknown; org?: unknown; plan?: unknown; renewsAt?: unknown; orgs?: unknown }>;
	plans?: Record<string, { capacityWeight?: unknown; monthlyPriceUsd?: unknown }>;
}

/**
 * Read + parse the subscription-config file into a {@link SubscriptionLookup}.
 * Fails loudly (throws) on a parse error or malformed shape so the broker never
 * silently emits partial series. Converts each account's `renewsAt` ISO date to
 * unix seconds. Returns `undefined` when no path is configured (env or flag).
 *
 * `metricsEnabled` short-circuits the read entirely, mirroring how
 * {@link resolveServeMetrics} returns before touching the scrape token when the
 * endpoint is off. Subscription data is consumed ONLY by the `/metrics` route,
 * so with the route disabled — the default, or an explicit
 * `--no-enable-metrics` — a stale, missing, or malformed file must not keep the
 * broker from starting. Reading it anyway would make disabling the feature
 * unable to recover from a metrics-only misconfiguration.
 */
export async function loadSubscriptionsConfig(
	pathArg: string | undefined,
	metricsEnabled: boolean,
): Promise<SubscriptionLookup | undefined> {
	if (!metricsEnabled) return undefined;
	const file = pathArg ?? process.env[SUBSCRIPTIONS_ENV];
	if (!file) return undefined;
	const raw = await Bun.file(file).text();
	return parseSubscriptionsConfig(raw, file);
}

/** A non-null, non-array plain JSON object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Canonicalize a config-supplied provider id to the form live usage reports
 * carry: trimmed and lowercased.
 *
 * The renderer joins config to reports on an exact `provider` key, and every id
 * in the catalog table is lowercase, so a report's `provider` is always the
 * bare lowercase id. An operator writing `"Anthropic"` would otherwise be stored
 * verbatim, match no report, and silently drop that account's plan/renewal
 * series while the broker logged a healthy start — the same silent omission the
 * surrounding trim-and-reject checks exist to prevent.
 *
 * Normalizing beats rejecting here because the exported `org`, `email`, and
 * `plan` labels are already case-folded on both sides (see `orgLabelOf`,
 * `emailLabelOf`, `canonicalizePlan`); making `provider` the one field where
 * casing is fatal rather than folded would be the surprising rule.
 */
function canonicalizeProviderId(provider: string): string {
	return provider.trim().toLowerCase();
}

/**
 * Parse a strict `YYYY-MM-DD` string as UTC midnight, rejecting shaped-valid but
 * out-of-range dates (`2026-02-29`) that {@link Date.parse} would silently
 * normalize into the next month. Returns epoch milliseconds, or `undefined` if
 * the components do not round-trip back to the input.
 */
function parseUtcDate(value: string): number | undefined {
	const [year, month, day] = value.split("-").map(Number);
	const ms = Date.UTC(year, month - 1, day);
	const date = new Date(ms);
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
		return undefined;
	}
	return ms;
}

/**
 * Validate + normalize the `plan`/`renewsAt` pair shared by an account-level
 * entry and each nested `orgs` entry. `label` names the offending entry in the
 * fail-loudly error (`account foo` or `account foo org bar`). Converts a
 * `YYYY-MM-DD` `renewsAt` to unix seconds; throws on any malformed field.
 */
/**
 * Reject keys the loader does not understand. The per-field checks below only
 * validate keys they know, so a misspelling (`renewAt` for `renewsAt`, `plans`
 * nested under an account) would be silently ignored and the corresponding
 * series quietly omitted — the opposite of this loader's fail-loudly contract.
 */
function rejectUnknownKeys(entry: object, allowed: readonly string[], file: string, label: string): void {
	const unknown = Object.keys(entry).filter(key => !allowed.includes(key));
	if (unknown.length > 0) {
		throw new Error(
			`subscription config ${file}: ${label} has unknown key(s) ${unknown.map(k => `"${k}"`).join(", ")}; allowed: ${allowed.map(k => `"${k}"`).join(", ")}`,
		);
	}
}

function parsePlanRenewal(
	entry: { plan?: unknown; renewsAt?: unknown },
	file: string,
	label: string,
): { plan?: string; renewsAtSeconds?: number } {
	if (entry.plan !== undefined) {
		if (typeof entry.plan !== "string") {
			throw new Error(`subscription config ${file}: ${label} "plan" must be a string`);
		}
		// The renderer canonicalizes an explicit plan and emits it as the
		// `plan` label. An empty/whitespace-only plan canonicalizes to "" and
		// would emit `plan=""` instead of falling back to the provider-reported
		// plan, so reject it here — omitting the field entirely stays valid.
		if (canonicalizePlan(entry.plan).length === 0) {
			throw new Error(`subscription config ${file}: ${label} "plan" must not be empty`);
		}
	}
	let renewsAtSeconds: number | undefined;
	if (entry.renewsAt !== undefined) {
		if (typeof entry.renewsAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.renewsAt)) {
			throw new Error(`subscription config ${file}: ${label} "renewsAt" must be a YYYY-MM-DD string`);
		}
		const ms = parseUtcDate(entry.renewsAt);
		if (ms === undefined) {
			throw new Error(`subscription config ${file}: ${label} "renewsAt" is not a valid date: ${entry.renewsAt}`);
		}
		renewsAtSeconds = ms / 1000;
	}
	return { plan: entry.plan as string | undefined, renewsAtSeconds };
}

/**
 * Parse raw subscription-config JSON into a {@link SubscriptionLookup}. Pure and
 * synchronous (no I/O): `file` is used only in error messages. Fails loudly
 * (throws) on a parse error or malformed shape so the broker never silently
 * emits partial series. Converts each account's `renewsAt` ISO date to unix
 * seconds.
 */
export function parseSubscriptionsConfig(raw: string, file: string): SubscriptionLookup {
	let root: unknown;
	try {
		root = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`subscription config ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isPlainObject(root)) {
		throw new Error(`subscription config ${file} must be a JSON object`);
	}
	// `isPlainObject` proves a non-null, non-array object; the per-field shapes
	// (all `unknown`) are validated below before any value is read.
	rejectUnknownKeys(root, ["accounts", "plans"], file, "root");
	const parsed = root as SubscriptionsConfigFile;

	// Per-account map, keyed by "<provider>\x00<account>\x00<org>" for the lookup.
	// `org` is the canonicalized organization scope (trim + lowercase, "" when the
	// entry declares none) so an account email's several org-scoped subscriptions
	// each carry their own plan/renewal instead of one config applying to both.
	// The same account id can appear in several orgs via the nested `orgs` map.
	const accounts = new Map<string, { plan?: string; renewsAtSeconds?: number }>();
	if (parsed.accounts !== undefined && !isPlainObject(parsed.accounts)) {
		throw new Error(`subscription config ${file}: "accounts" must be a JSON object`);
	}
	for (const [account, entry] of Object.entries(parsed.accounts ?? {})) {
		if (typeof entry !== "object" || entry === null) {
			throw new Error(`subscription config ${file}: account ${account} must be an object`);
		}
		rejectUnknownKeys(entry, ["provider", "org", "plan", "renewsAt", "orgs"], file, `account ${account}`);
		if (typeof entry.provider !== "string") {
			throw new Error(`subscription config ${file}: account ${account} is missing a string "provider"`);
		}
		// Trimmed, not just length-checked: a whitespace-only `provider` or account
		// key parses fine and is stored under a composite key no usage report can
		// ever produce, so the account's plan and renewal series vanish while the
		// broker reports a healthy start — the silent omission this loader exists
		// to prevent.
		if (entry.provider.trim().length === 0 || account.trim().length === 0) {
			throw new Error(
				`subscription config ${file}: account ${account} "provider" and account key must be non-empty and not whitespace-only`,
			);
		}
		// A malformed `org` (e.g. a number) must fail loudly, not silently coerce
		// to the empty scope — an empty-scope entry would then answer for EVERY
		// org of the account, defeating org scoping.
		if (entry.org !== undefined && typeof entry.org !== "string") {
			throw new Error(`subscription config ${file}: account ${account} "org" must be a string`);
		}
		// A whitespace-only `org` (e.g. "   ") canonicalizes to the empty scope,
		// which the lookup below treats as the all-orgs fallback — so a typo would
		// silently apply this plan/renewal to every org of the account. An org-less
		// entry (no `org` key, or a legitimately empty "") is the intended
		// fallback; only a value that was non-empty as written but trims away is
		// rejected.
		if (typeof entry.org === "string" && entry.org.length > 0 && entry.org.trim().length === 0) {
			throw new Error(`subscription config ${file}: account ${account} "org" must not be whitespace-only`);
		}
		const org = typeof entry.org === "string" ? entry.org.trim().toLowerCase() : "";
		// Store the canonical identity: the lookup key is built from live credential
		// fields, so a padded config value ("  anthropic  ") would never match.
		// Case-folded for the same reason — see {@link canonicalizeProviderId}.
		const provider = canonicalizeProviderId(entry.provider);
		const accountKey = account.trim();
		// Two JSON properties that normalize to the same identity (e.g. "acct-1"
		// and " acct-1 ") would collide on this key, and the surviving plan would
		// depend on property order. Reject rather than resolve: the operator's
		// intent is unknowable and silently picking one contradicts the
		// fail-loudly contract the rest of this loader keeps.
		const accountIdentity = `${provider}\x00${accountKey}\x00${org}`;
		if (accounts.has(accountIdentity)) {
			throw new Error(
				`subscription config ${file}: account ${account} duplicates an earlier entry after trimming (provider "${provider}", account "${accountKey}", org "${org}")`,
			);
		}
		accounts.set(accountIdentity, parsePlanRenewal(entry, file, `account ${account}`));

		// Additional org scopes for the same account id: keyed by org id, each
		// with its own plan/renewal. A top-level `org` plus an `orgs` entry for
		// the same canonical scope would collide, so reject the duplicate.
		if (entry.orgs !== undefined) {
			if (!isPlainObject(entry.orgs)) {
				throw new Error(`subscription config ${file}: account ${account} "orgs" must be a JSON object`);
			}
			for (const [orgKey, orgEntry] of Object.entries(entry.orgs)) {
				if (typeof orgEntry !== "object" || orgEntry === null || Array.isArray(orgEntry)) {
					throw new Error(`subscription config ${file}: account ${account} org ${orgKey} must be an object`);
				}
				// An `orgs` key whose canonical (trimmed) scope is empty — the literal
				// empty string "" or whitespace-only like "   " — canonicalizes to the
				// empty scope, which, absent a bare entry, the lookup treats as the
				// all-orgs fallback, so it would apply this plan/renewal to unrelated
				// orgs. An org key is meant to name a specific scope, so reject one
				// that canonicalizes away entirely.
				rejectUnknownKeys(orgEntry, ["plan", "renewsAt"], file, `account ${account} org ${orgKey}`);
				if (orgKey.trim().length === 0) {
					throw new Error(
						`subscription config ${file}: account ${account} "orgs" key must name a scope, not be empty or whitespace-only`,
					);
				}
				const orgScope = orgKey.trim().toLowerCase();
				const key = `${provider}\x00${accountKey}\x00${orgScope}`;
				if (accounts.has(key)) {
					throw new Error(
						`subscription config ${file}: account ${account} declares org scope "${orgScope}" more than once`,
					);
				}
				accounts.set(
					key,
					parsePlanRenewal(
						orgEntry as { plan?: unknown; renewsAt?: unknown },
						file,
						`account ${account} org ${orgKey}`,
					),
				);
			}
		}
	}

	// Per-plan table, keys are "<provider>:<plan>".
	const plans: Array<{ provider: string; plan: string; capacityWeight: number; monthlyPriceUsd: number }> = [];
	// Two plan keys whose {provider, canonicalized plan} collapse to one exported
	// identity (e.g. "anthropic:Max Plan" and "anthropic:max-plan") would both be
	// accepted here, but the renderer dedups by that identity and silently keeps
	// only the first — so config order would decide the reported facts. Reject
	// the collision loudly instead.
	const seenPlanIdentities = new Set<string>();
	if (parsed.plans !== undefined && !isPlainObject(parsed.plans)) {
		throw new Error(`subscription config ${file}: "plans" must be a JSON object`);
	}
	for (const [key, entry] of Object.entries(parsed.plans ?? {})) {
		if (typeof entry !== "object" || entry === null) {
			throw new Error(`subscription config ${file}: plan ${key} must be an object`);
		}
		rejectUnknownKeys(entry, ["capacityWeight", "monthlyPriceUsd"], file, `plan ${key}`);
		const sep = key.indexOf(":");
		if (sep <= 0 || sep === key.length - 1) {
			throw new Error(`subscription config ${file}: plan key ${key} must be "<provider>:<plan>"`);
		}
		if (typeof entry.capacityWeight !== "number" || typeof entry.monthlyPriceUsd !== "number") {
			throw new Error(
				`subscription config ${file}: plan ${key} needs numeric "capacityWeight" and "monthlyPriceUsd"`,
			);
		}
		// A capacity multiplier and a list price are exported straight to
		// `/metrics`; a negative or non-finite (NaN/Inf) value would publish a
		// nonsense gauge, so reject it at parse the same way a bad type is. Zero
		// price is a valid free plan; zero capacityWeight is degenerate but not
		// invalid on its face, so only strictly-negative and non-finite are
		// rejected here.
		if (!Number.isFinite(entry.capacityWeight) || entry.capacityWeight < 0) {
			throw new Error(
				`subscription config ${file}: plan ${key} "capacityWeight" must be a non-negative finite number`,
			);
		}
		if (!Number.isFinite(entry.monthlyPriceUsd) || entry.monthlyPriceUsd < 0) {
			throw new Error(
				`subscription config ${file}: plan ${key} "monthlyPriceUsd" must be a non-negative finite number`,
			);
		}
		// Canonicalize the provider segment: account providers are canonicalized
		// above and live usage reports arrive with the bare lowercase id, so a
		// padded or mis-cased plan key like " Anthropic :max" would publish
		// capacity/price series under a provider label that joins no account's
		// subscription series.
		const provider = canonicalizeProviderId(key.slice(0, sep));
		const plan = key.slice(sep + 1);
		if (provider.length === 0) {
			throw new Error(`subscription config ${file}: plan ${key} has an empty provider segment`);
		}
		// A raw suffix that canonicalizes to empty (e.g. "anthropic:chatgpt_" or
		// trailing whitespace) passes the separator check above but would export
		// capacity/price samples with `plan=""` that join no valid account.
		// Mirror the empty-plan rejection parsePlanRenewal applies to the
		// account path.
		if (canonicalizePlan(plan).length === 0) {
			throw new Error(`subscription config ${file}: plan key ${key} "plan" must not be canonically empty`);
		}
		const identity = `${provider}:${canonicalizePlan(plan)}`;
		if (seenPlanIdentities.has(identity)) {
			throw new Error(
				`subscription config ${file}: plan key ${key} duplicates canonical plan ${canonicalizePlan(plan)}`,
			);
		}
		seenPlanIdentities.add(identity);
		plans.push({
			provider,
			plan,
			capacityWeight: entry.capacityWeight,
			monthlyPriceUsd: entry.monthlyPriceUsd,
		});
	}

	return {
		// Prefer the exact org-scoped entry; fall back to an org-less config entry
		// so a pre-org config (no `org` key) still resolves for every org of that
		// account, matching the prior single-key behavior.
		lookup: (provider, account, org) =>
			accounts.get(`${provider}\x00${account}\x00${org}`) ??
			(org.length > 0 ? accounts.get(`${provider}\x00${account}\x00`) : undefined),
		plans,
	};
}

/**
 * OAuth refresh handler for `omp auth-broker serve`'s {@link AuthStorage}.
 *
 * The vault holds provider OAuth rows AND OMP-managed `mcp_oauth:*` rows.
 * Provider rows refresh through the per-provider registry. MCP rows are
 * self-describing — the embedded token endpoint and client credentials are the
 * only refresh material — so they refresh with a generic `refresh_token` grant.
 * The serve process never loads the MCP manager, so this is the only place that
 * teaches the broker to refresh MCP tokens; without it
 * `POST /v1/credential/:id/refresh` fails with "Unknown OAuth provider" and the
 * background refresher lets MCP access tokens expire (issue #8933).
 */
export function refreshBrokerOAuthCredential(
	provider: string,
	credential: OAuthCredential,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	if (isManagedMCPOAuthCredentialId(provider)) {
		return refreshManagedMcpOAuthCredential(credential, {
			serverUrl: mcpOAuthServerUrlFromCredentialId(provider),
			signal,
		});
	}
	// Non-MCP rows: same per-provider path AuthStorage would take by default
	// (the serve process registers no custom OAuth providers).
	return refreshOAuthToken(provider as OAuthProvider, credential);
}

async function runServe(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	// The broker is a long-running headless service: route structured logs to
	// stdout so a process supervisor (pm2, journald, k8s) captures them, and
	// skip the rotating ~/.omp/logs/ file the TUI default would have used.
	setLoggerTransports({ console: true, file: false });

	const bind = flags.bind ?? DEFAULT_AUTH_BROKER_BIND;
	const token = await ensureTokenFile(getTokenFilePath());
	// Opt-in: resolved before anything touches the scrape token, so a deployment
	// that never asked for `/metrics` performs no token I/O at all.
	const metrics = await resolveServeMetrics(resolveEnableMetricsFlag(flags.enableMetrics, flags.noEnableMetrics));
	const dbPath = getAgentDbPath();
	const store = await SqliteAuthCredentialStore.open(dbPath);
	const storage = new AuthStorage(store, {
		refreshOAuthCredential: (provider, _credentialId, credential, signal) =>
			refreshBrokerOAuthCredential(provider, credential, signal),
	});
	await storage.reload();
	// Load the static subscription config if a path is set via the flag or
	// `OMP_AUTH_BROKER_SUBSCRIPTIONS`; a parse/shape error throws so the broker
	// never boots emitting partial series. Unset → omit, broker runs exactly as
	// before. Skipped entirely while `/metrics` is off — the disabled route is
	// its only consumer, so a bad file must not block startup.
	const subscriptions = await loadSubscriptionsConfig(flags.subscriptionsConfig, metrics.enabled);
	if (subscriptions) logger.info("auth-broker subscription config loaded", { plans: subscriptions.plans.length });
	const handle = startAuthBroker({
		storage,
		bind,
		bearerTokens: [token],
		metricsEnabled: metrics.enabled,
		...(metrics.enabled ? { metricsTokens: [metrics.token] } : {}),
		...(subscriptions ? { subscriptions } : {}),
		version: VERSION,
	});
	logger.info("auth-broker listening", { url: handle.url });
	logger.info("auth-broker bearer token loaded", { path: getTokenFilePath(), mode: "0600" });
	if (metrics.enabled) logger.info("auth-broker metrics endpoint enabled", { tokenSource: metrics.source });

	const credentialDisabledUnsub = storage.onCredentialDisabled((event: CredentialDisabledEvent) => {
		logger.warn("auth-broker credential disabled", { ...event });
	});

	const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
		logger.info("auth-broker shutting down", { signal });
		credentialDisabledUnsub();
		await handle.close();
		storage.close();
		process.exit(0);
	};
	process.once("SIGINT", () => void shutdown("SIGINT"));
	process.once("SIGTERM", () => void shutdown("SIGTERM"));

	// Block forever; lifecycle is signal-driven.
	await new Promise<never>(() => {});
}

async function runToken(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	// `--metrics` selects the scrape-scoped read-only token; otherwise this
	// manages the master bearer, unchanged.
	const file = flags.metrics ? getMetricsTokenFilePath() : getTokenFilePath();
	if (flags.regenerate) {
		const next = generateToken();
		await writeTokenFile(file, next);
		if (flags.json) {
			process.stdout.write(`${JSON.stringify({ token: next, path: file })}\n`);
		} else {
			process.stdout.write(`${next}\n`);
		}
		return;
	}
	const token = await ensureTokenFile(file);
	if (flags.json) {
		process.stdout.write(`${JSON.stringify({ token, path: file })}\n`);
	} else {
		process.stdout.write(`${token}\n`);
	}
}

async function runLogin(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	const providers = getOAuthProviders();
	let providerArg = flags.provider;
	if (!providerArg) {
		if (flags.via) {
			throw new Error(
				"Usage: omp auth-broker login <provider> --via=user@host (provider required for remote login)",
			);
		}
		providerArg = await pickProviderInteractively(providers);
	}
	if (!providers.some(p => p.id === providerArg)) {
		throw new Error(
			`Unknown OAuth provider '${providerArg}'. Known: ${providers
				.map(p => p.id)
				.sort()
				.join(", ")}`,
		);
	}
	if (flags.via) {
		await runRemoteLogin(providerArg, flags.via, flags.dryRun ?? false);
		return;
	}
	await runLocalLogin(providerArg as OAuthProvider);
}

async function runLocalLogin(provider: OAuthProvider): Promise<void> {
	// Drive the per-provider OAuth dance in-process. Persists into the same
	// SQLite store the broker uses.
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const ask = (msg: string, signal?: AbortSignal) => promptLine(rl, `${msg} `, signal);
	const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
	const storage = new AuthStorage(store);
	await storage.reload();
	try {
		// Only paste-code providers (fixed non-loopback redirect, e.g. GitLab Duo
		// Agent's vscode:// URI) get the manual paste fallback. An explicit
		// `onManualCodeInput` is honored for ANY provider (the storage escape hatch),
		// so for loopback providers we do not pass it: an eager readline prompt adds
		// noise to a flow that normally completes through HTTP. `AuthStorage.login`
		// independently refuses to synthesize the default prompt
		// for non-paste-code providers, so this is defense-in-depth on the same gate.
		const usesManualInput = PASTE_CODE_LOGIN_PROVIDERS.has(provider);
		await storage.login(provider, {
			onAuth({ url, launchUrl, instructions }) {
				process.stdout.write("\nOpen this URL in your browser:\n");
				// Full URL first so the CLI works from any machine, including SSH
				// sessions where a `launchUrl` (loopback `/launch` on the OMP
				// host) would resolve against the caller's browser and fail.
				// Headless capture is unaffected: it reads the first URL line.
				process.stdout.write(`${url}\n`);
				if (launchUrl && launchUrl !== url) {
					// Local shortcut for the machine running OMP. Terminals or
					// screen-scrapers narrower than the full URL still get an
					// unbroken copy target here.
					process.stdout.write(`Local shortcut (this machine only): ${launchUrl}\n`);
				}
				if (instructions) process.stdout.write(`${instructions}\n`);
				process.stdout.write("\n");
			},
			onProgress(message) {
				process.stdout.write(`${message}\n`);
			},
			onPrompt(p) {
				return ask(`${p.message}${p.placeholder ? ` (${p.placeholder})` : ""}:`);
			},
			...(usesManualInput
				? {
						onManualCodeInput(signal) {
							return ask("Paste the authorization code (or full redirect URL):", signal);
						},
					}
				: undefined),
		});
		process.stdout.write(`\nCredentials saved to ${getAgentDbPath()}\n`);
	} finally {
		store.close();
		rl.close();
	}
}

/**
 * Interactive `readline` prompt that cleanly tears down on Ctrl-C / Escape so
 * cancelling a half-finished login flow doesn't leave the terminal in raw mode.
 */
function promptLine(rl: readline.Interface, question: string, signal?: AbortSignal): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const input = process.stdin as NodeJS.ReadStream;
	const supportsRawMode = input.isTTY && typeof input.setRawMode === "function";
	const wasRaw = supportsRawMode ? input.isRaw : false;
	let settled = false;

	const cleanup = () => {
		rl.off("SIGINT", onSigint);
		signal?.removeEventListener("abort", onAbort);
		if (supportsRawMode) {
			input.off("keypress", onKeypress);
			input.setRawMode?.(wasRaw);
		}
	};

	const finish = (result: () => void) => {
		if (settled) return;
		settled = true;
		cleanup();
		result();
	};

	const cancel = () => {
		finish(() => reject(new Error("Login cancelled")));
	};

	const onSigint = () => {
		cancel();
	};

	const onAbort = () => {
		finish(() => reject(signal?.reason instanceof Error ? signal.reason : new Error("Login input cancelled")));
	};

	const onKeypress = (_str: string, key: readline.Key) => {
		if (key.name === "escape" || (key.ctrl && key.name === "c")) {
			cancel();
			rl.close();
		}
	};

	if (supportsRawMode) {
		readline.emitKeypressEvents(input, rl);
		input.setRawMode(true);
		input.on("keypress", onKeypress);
	}

	rl.once("SIGINT", onSigint);
	if (signal?.aborted) {
		onAbort();
	} else if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
		rl.question(question, { signal }, answer => {
			finish(() => resolve(answer));
		});
	} else {
		rl.question(question, answer => {
			finish(() => resolve(answer));
		});
	}
	return promise;
}

async function pickProviderInteractively(providers: readonly OAuthProviderInfo[]): Promise<string> {
	if (providers.length === 0) {
		throw new Error("No OAuth providers registered");
	}
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		process.stdout.write("Select a provider:\n\n");
		for (let i = 0; i < providers.length; i++) {
			process.stdout.write(`  ${i + 1}. ${providers[i].name}\n`);
		}
		process.stdout.write("\n");
		const choice = await promptLine(rl, `Enter number (1-${providers.length}): `);
		const index = Number.parseInt(choice, 10) - 1;
		if (Number.isNaN(index) || index < 0 || index >= providers.length) {
			throw new Error(`Invalid selection: ${choice}`);
		}
		return providers[index].id;
	} finally {
		rl.close();
	}
}

async function runRemoteLogin(provider: string, via: string, dryRun: boolean): Promise<void> {
	const port = CALLBACK_PORTS[provider];
	if (port === undefined) {
		throw new Error(
			`No known OAuth callback port for '${provider}'. Use device-code flow on the broker host directly.`,
		);
	}
	const sshArgs = [
		"-L",
		`${port}:127.0.0.1:${port}`,
		"-o",
		"ExitOnForwardFailure=yes",
		via,
		`${APP_NAME} auth-broker login ${provider}`,
	];
	if (dryRun) {
		process.stdout.write(`ssh ${sshArgs.map(a => (a.includes(" ") ? `'${a}'` : a)).join(" ")}\n`);
		return;
	}
	const sshBin = $which("ssh");
	if (!sshBin) {
		throw new Error("ssh binary not found in PATH");
	}
	const proc = Bun.spawn({
		cmd: [sshBin, ...sshArgs],
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`ssh exited with code ${exitCode}`);
	}
}

async function runLogout(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	let providerArg = flags.provider;
	const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
	try {
		if (!providerArg) {
			const stored = store.listProviders();
			if (stored.length === 0) {
				process.stdout.write("No credentials stored.\n");
				return;
			}
			providerArg = await pickStoredProviderInteractively(stored);
		}
		store.deleteAuthCredentialsForProvider(providerArg, "logged out by user");
		process.stdout.write(`Logged out of ${providerArg}\n`);
	} finally {
		store.close();
	}
}

async function pickStoredProviderInteractively(providers: string[]): Promise<string> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		process.stdout.write("Select a provider to logout:\n\n");
		for (let i = 0; i < providers.length; i++) {
			process.stdout.write(`  ${i + 1}. ${providers[i]}\n`);
		}
		process.stdout.write("\n");
		const choice = await promptLine(rl, `Enter number (1-${providers.length}): `);
		const index = Number.parseInt(choice, 10) - 1;
		if (Number.isNaN(index) || index < 0 || index >= providers.length) {
			throw new Error(`Invalid selection: ${choice}`);
		}
		return providers[index];
	} finally {
		rl.close();
	}
}

async function runList(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	const providers = getOAuthProviders();
	if (flags.json) {
		process.stdout.write(`${JSON.stringify(providers.map(p => ({ id: p.id, name: p.name })))}\n`);
		return;
	}
	process.stdout.write("Available providers:\n\n");
	for (const p of providers) {
		process.stdout.write(`  ${p.id.padEnd(20)} ${p.name}\n`);
	}
}

// ─── CLIProxyAPI import ─────────────────────────────────────────────────

/**
 * Maps the `type` field of a CLIProxyAPI credential JSON to the omp provider id.
 * The filename also encodes the type (e.g. `claude-foo@bar.json`), but the
 * in-file `type` is authoritative — we only fall back to filename if absent.
 */
const CLIPROXY_TYPE_TO_PROVIDER: Record<string, string> = {
	claude: "anthropic",
	codex: "openai-codex",
	gemini: "google-gemini-cli",
	antigravity: "google-antigravity",
	"gemini-cli": "google-gemini-cli",
};

interface CliProxyCredentialJson {
	type?: string;
	access_token?: string;
	refresh_token?: string;
	id_token?: string;
	expired?: string;
	last_refresh?: string;
	email?: string;
	account_id?: string;
	disabled?: boolean;
}

interface ImportPlanEntry {
	sourceFile: string;
	provider: string;
	email: string | null;
	accountId: string | null;
	expiresAt: number;
	disabled: boolean;
	credential: OAuthCredential;
}

function resolveCliProxyProvider(json: CliProxyCredentialJson, filename: string, overrideId?: string): string | null {
	if (overrideId && overrideId.length > 0) return overrideId;
	const typeField = json.type?.trim().toLowerCase();
	if (typeField && CLIPROXY_TYPE_TO_PROVIDER[typeField]) return CLIPROXY_TYPE_TO_PROVIDER[typeField];
	// Fall back to filename prefix: `<type>-<email>.json`
	const base = path.basename(filename, ".json").toLowerCase();
	for (const prefix in CLIPROXY_TYPE_TO_PROVIDER) {
		const providerId = CLIPROXY_TYPE_TO_PROVIDER[prefix];
		if (base.startsWith(`${prefix}-`) || base === prefix) return providerId;
	}
	return null;
}

function parseCliProxyExpiry(raw: string | undefined): number | null {
	if (!raw) return null;
	// CLIProxyAPI writes RFC3339-ish dates. `Date.parse` handles both `Z` and offsets.
	const ms = Date.parse(raw);
	if (!Number.isFinite(ms)) return null;
	return ms;
}

async function collectImportSources(target: string): Promise<string[]> {
	const stat = await fs.stat(target);
	if (stat.isFile()) return [target];
	if (!stat.isDirectory()) {
		throw new Error(`Import source is neither file nor directory: ${target}`);
	}
	const entries = await fs.readdir(target, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (!entry.name.endsWith(".json")) continue;
		files.push(path.join(target, entry.name));
	}
	files.sort();
	return files;
}

async function loadImportPlan(
	target: string,
	overrideProvider: string | undefined,
	includeDisabled: boolean,
): Promise<{ entries: ImportPlanEntry[]; skipped: Array<{ file: string; reason: string }> }> {
	const files = await collectImportSources(target);
	const entries: ImportPlanEntry[] = [];
	const skipped: Array<{ file: string; reason: string }> = [];
	for (const file of files) {
		let json: CliProxyCredentialJson;
		try {
			json = (await Bun.file(file).json()) as CliProxyCredentialJson;
		} catch (err) {
			skipped.push({ file, reason: `unreadable JSON: ${String(err)}` });
			continue;
		}
		if (json.disabled === true && !includeDisabled) {
			skipped.push({ file, reason: "credential marked disabled (use --include-disabled to import anyway)" });
			continue;
		}
		const provider = resolveCliProxyProvider(json, file, overrideProvider);
		if (!provider) {
			skipped.push({
				file,
				reason: `cannot determine omp provider from type=${json.type ?? "?"} (pass --provider to override)`,
			});
			continue;
		}
		if (!json.access_token || !json.refresh_token) {
			skipped.push({ file, reason: "missing access_token or refresh_token" });
			continue;
		}
		const expiresAt = parseCliProxyExpiry(json.expired);
		if (expiresAt === null) {
			skipped.push({ file, reason: `cannot parse expired=${json.expired ?? "?"}` });
			continue;
		}
		const email = typeof json.email === "string" && json.email.length > 0 ? json.email : null;
		const accountId = typeof json.account_id === "string" && json.account_id.length > 0 ? json.account_id : null;
		const credential: OAuthCredential = {
			type: "oauth",
			access: json.access_token,
			refresh: json.refresh_token,
			expires: expiresAt,
			...(email !== null ? { email } : {}),
			...(accountId !== null ? { accountId } : {}),
		};
		entries.push({
			sourceFile: file,
			provider,
			email,
			accountId,
			expiresAt,
			disabled: json.disabled === true,
			credential,
		});
	}
	return { entries, skipped };
}

function describeImportEntry(entry: ImportPlanEntry): string {
	const ident = entry.email ?? entry.accountId ?? "(no identity)";
	const stale = entry.expiresAt < Date.now() ? " [expired]" : "";
	const disabled = entry.disabled ? " [disabled]" : "";
	return `${entry.provider}: ${ident}${stale}${disabled} from ${entry.sourceFile}`;
}

async function runImport(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	const target = flags.source;
	if (!target) {
		throw new Error("Usage: omp auth-broker import <file|dir> [--provider=<id>] [--include-disabled] [--dry-run]");
	}
	const resolvedTarget = path.resolve(target.startsWith("~") ? target.replace(/^~/, os.homedir()) : target);
	const { entries, skipped } = await loadImportPlan(resolvedTarget, flags.provider, flags.includeDisabled === true);

	if (flags.json) {
		process.stdout.write(
			`${JSON.stringify({
				dryRun: flags.dryRun === true,
				imported: flags.dryRun
					? []
					: entries.map(e => ({ provider: e.provider, email: e.email, file: e.sourceFile })),
				plan: entries.map(e => ({
					provider: e.provider,
					email: e.email,
					accountId: e.accountId,
					expiresAt: e.expiresAt,
					disabled: e.disabled,
					file: e.sourceFile,
				})),
				skipped,
			})}\n`,
		);
	}

	if (!flags.json) {
		for (const skip of skipped) {
			process.stdout.write(`${chalk.yellow("skip")} ${skip.file}: ${skip.reason}\n`);
		}
	}

	if (entries.length === 0) {
		if (!flags.json) process.stdout.write(`No importable credentials in ${resolvedTarget}.\n`);
		return;
	}

	if (flags.dryRun === true) {
		if (!flags.json) {
			process.stdout.write(`Dry run — would import ${entries.length} credential(s):\n`);
			for (const entry of entries) process.stdout.write(`  ${describeImportEntry(entry)}\n`);
		}
		return;
	}

	const brokerConfig = await resolveAuthBrokerConfig();
	if (brokerConfig) {
		const client = new AuthBrokerClient({ url: brokerConfig.url, token: brokerConfig.token });
		for (const entry of entries) {
			try {
				await client.uploadCredential(entry.provider, entry.credential);
				if (!flags.json) {
					process.stdout.write(`${chalk.green("uploaded")} ${describeImportEntry(entry)} → ${brokerConfig.url}\n`);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (flags.json) {
					process.stdout.write(`${JSON.stringify({ error: message, file: entry.sourceFile })}\n`);
				} else {
					process.stdout.write(`${chalk.red("failed")} ${describeImportEntry(entry)}: ${message}\n`);
				}
				process.exitCode = 1;
			}
		}
		return;
	}

	const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
	try {
		for (const entry of entries) {
			store.upsertAuthCredentialForProvider(entry.provider, entry.credential);
			if (!flags.json) process.stdout.write(`${chalk.green("imported")} ${describeImportEntry(entry)}\n`);
		}
	} finally {
		store.close();
	}
}

// ─── Migrate: local SQLite + env → broker ──────────────────────────────

interface MigratePlanEntry {
	source: "local-sqlite" | "env";
	provider: string;
	credential: AuthCredential;
	identity: string;
}

interface MigrateSkip {
	source: "local-sqlite" | "env";
	provider: string;
	identity: string;
	reason: string;
}

function credentialIdentity(provider: string, credential: AuthCredential): string {
	if (credential.type === "api_key") return "(api key)";
	const base = credential.email ?? credential.accountId ?? credential.projectId ?? `<${provider} oauth>`;
	return credential.orgId ? `${base} (${credential.orgName ?? credential.orgId})` : base;
}

/**
 * Build the set of "identities already on the broker" so re-runs are idempotent.
 * For OAuth, identity = email|accountId|projectId, each org-qualified when the
 * row carries an organization (one Anthropic email can hold a Team seat AND a
 * personal Max plan — those must migrate as two rows). A row with NO base
 * identity but an orgId (login recovered neither email nor account) is marked
 * by the org alone, so re-running migrate does not re-upload a stale refresh
 * token over the broker's newer one. For api_key, we collapse to a single
 * marker per provider (broker has no concept of "multiple api keys per
 * provider with different identities"; upsert would coalesce them).
 */
function indexBrokerSnapshot(snapshot: {
	credentials: Array<{
		provider: string;
		credential: { type: string; email?: string; accountId?: string; projectId?: string; orgId?: string };
	}>;
}): Map<string, Set<string>> {
	const out = new Map<string, Set<string>>();
	for (const entry of snapshot.credentials) {
		const ids = out.get(entry.provider) ?? new Set<string>();
		if (entry.credential.type === "api_key") {
			ids.add("@api_key");
		} else {
			const orgSuffix = entry.credential.orgId ? `|org:${entry.credential.orgId}` : "";
			if (entry.credential.email) ids.add(`email:${entry.credential.email}${orgSuffix}`);
			if (entry.credential.accountId) ids.add(`accountId:${entry.credential.accountId}${orgSuffix}`);
			if (entry.credential.projectId) ids.add(`projectId:${entry.credential.projectId}${orgSuffix}`);
			if (
				!entry.credential.email &&
				!entry.credential.accountId &&
				!entry.credential.projectId &&
				entry.credential.orgId
			) {
				ids.add(`org:${entry.credential.orgId}`);
			}
		}
		out.set(entry.provider, ids);
	}
	return out;
}

function brokerAlreadyHas(existing: Map<string, Set<string>>, provider: string, credential: AuthCredential): boolean {
	const ids = existing.get(provider);
	if (!ids) return false;
	if (credential.type === "api_key") return ids.has("@api_key");
	const orgSuffix = credential.orgId ? `|org:${credential.orgId}` : "";
	if (credential.email && ids.has(`email:${credential.email}${orgSuffix}`)) return true;
	if (credential.accountId && ids.has(`accountId:${credential.accountId}${orgSuffix}`)) return true;
	if (credential.projectId && ids.has(`projectId:${credential.projectId}${orgSuffix}`)) return true;
	if (!credential.email && !credential.accountId && !credential.projectId && credential.orgId) {
		return ids.has(`org:${credential.orgId}`);
	}
	return false;
}

async function runMigrate(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	const brokerConfig = await resolveAuthBrokerConfig();
	if (!brokerConfig) {
		throw new Error(
			"OMP_AUTH_BROKER_URL must be set (or `auth.broker.url` in config.yml). `migrate` uploads local credentials to a configured broker.",
		);
	}
	if (flags.fromLocal !== true) {
		throw new Error(
			"`omp auth-broker migrate` requires an explicit source. Pass `--from-local` to migrate from the local SQLite store and env vars.",
		);
	}

	const client = new AuthBrokerClient({ url: brokerConfig.url, token: brokerConfig.token });
	const snapshotResult = await client.fetchSnapshot();
	if (snapshotResult.status !== 200) throw new Error("Auth broker returned no snapshot");
	const existing = indexBrokerSnapshot(snapshotResult.snapshot);

	const plan: MigratePlanEntry[] = [];
	const skipped: MigrateSkip[] = [];

	// 1. Local SQLite rows.
	const localDbPath = getAgentDbPath();
	const localStore = await SqliteAuthCredentialStore.open(localDbPath);
	const plannedApiKeyProviders = new Set<string>();
	try {
		for (const row of localStore.listAuthCredentials()) {
			// Skip placeholder sentinels that pi-ai treats as "authenticated via
			// out-of-band mechanism" (Bedrock/Vertex `<authenticated>`). They
			// aren't real keys and uploading them would store garbage on the
			// broker. Mirrors the env-var path's guard below.
			if (row.credential.type === "api_key" && row.credential.key === "<authenticated>") {
				skipped.push({
					source: "local-sqlite",
					provider: row.provider,
					identity: "(api key)",
					reason: "placeholder sentinel '<authenticated>' is not a real key",
				});
				continue;
			}
			const identity = credentialIdentity(row.provider, row.credential);
			if (row.credential.type === "oauth" && flags.includeOauth !== true) {
				skipped.push({
					source: "local-sqlite",
					provider: row.provider,
					identity,
					reason: "OAuth from local SQLite skipped by default (use --include-oauth)",
				});
				continue;
			}
			if (brokerAlreadyHas(existing, row.provider, row.credential)) {
				skipped.push({
					source: "local-sqlite",
					provider: row.provider,
					identity,
					reason: "already on broker",
				});
				continue;
			}
			if (row.credential.type === "api_key" && plannedApiKeyProviders.has(row.provider)) {
				skipped.push({
					source: "local-sqlite",
					provider: row.provider,
					identity,
					reason: "another local api_key for this provider already planned",
				});
				continue;
			}
			if (row.credential.type === "api_key") plannedApiKeyProviders.add(row.provider);
			plan.push({ source: "local-sqlite", provider: row.provider, credential: row.credential, identity });
		}
	} finally {
		localStore.close();
	}

	// 2. Env-var API keys (opt-in).
	if (flags.includeEnv === true) {
		for (const provider of listProvidersWithEnvKey()) {
			const envValue = getEnvApiKey(provider);
			if (!envValue) continue;
			if (envValue === "<authenticated>") continue; // Bedrock/Vertex sentinels — not literal keys.
			const credential: AuthCredential = { type: "api_key", key: envValue };
			if (brokerAlreadyHas(existing, provider, credential)) {
				skipped.push({
					source: "env",
					provider,
					identity: "(api key)",
					reason: "already on broker (provider has an api_key)",
				});
				continue;
			}
			// Also skip if local SQLite already produced an entry for this provider in this batch.
			if (plan.some(p => p.provider === provider && p.credential.type === "api_key")) {
				skipped.push({
					source: "env",
					provider,
					identity: "(api key)",
					reason: "local SQLite already supplied an api_key for this provider",
				});
				continue;
			}
			plan.push({ source: "env", provider, credential, identity: "(api key)" });
		}
	}

	if (flags.json) {
		process.stdout.write(
			`${JSON.stringify({
				dryRun: flags.dryRun === true,
				plan: plan.map(p => ({ source: p.source, provider: p.provider, identity: p.identity })),
				skipped,
			})}\n`,
		);
	} else {
		for (const skip of skipped) {
			process.stdout.write(
				`${chalk.yellow("skip")} [${skip.source}] ${skip.provider} ${skip.identity}: ${skip.reason}\n`,
			);
		}
	}

	if (plan.length === 0) {
		if (!flags.json) process.stdout.write("Nothing to migrate.\n");
		return;
	}

	if (flags.dryRun === true) {
		if (!flags.json) {
			process.stdout.write(`Dry run — would upload ${plan.length} credential(s):\n`);
			for (const entry of plan) {
				process.stdout.write(`  [${entry.source}] ${entry.provider} ${entry.identity}\n`);
			}
		}
		return;
	}

	for (const entry of plan) {
		try {
			await client.uploadCredential(entry.provider, entry.credential);
			if (!flags.json) {
				process.stdout.write(`${chalk.green("uploaded")} [${entry.source}] ${entry.provider} ${entry.identity}\n`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (flags.json) {
				process.stdout.write(`${JSON.stringify({ error: message, provider: entry.provider })}\n`);
			} else {
				process.stdout.write(`${chalk.red("failed")} [${entry.source}] ${entry.provider}: ${message}\n`);
			}
			process.exitCode = 1;
		}
	}
}

async function runStatus(flags: AuthBrokerCommandArgs["flags"]): Promise<void> {
	const cfg = await resolveAuthBrokerConfig();
	if (!cfg) {
		const message = "No auth-broker configured (set OMP_AUTH_BROKER_URL to enable).";
		if (flags.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: "not_configured" })}\n`);
		else process.stdout.write(`${chalk.yellow(message)}\n`);
		return;
	}
	const client = new AuthBrokerClient({ url: cfg.url, token: cfg.token });
	try {
		const health = await client.healthz();
		if (flags.json) {
			process.stdout.write(`${JSON.stringify({ url: cfg.url, ...health })}\n`);
		} else {
			process.stdout.write(`${chalk.green("OK")} ${cfg.url} (version=${health.version ?? "unknown"})\n`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (flags.json) {
			process.stdout.write(`${JSON.stringify({ ok: false, url: cfg.url, error: message })}\n`);
		} else {
			process.stdout.write(`${chalk.red("FAILED")} ${cfg.url}: ${message}\n`);
		}
		process.exitCode = 1;
	}
}

export async function runAuthBrokerCommand(cmd: AuthBrokerCommandArgs): Promise<void> {
	switch (cmd.action) {
		case "serve":
			await runServe(cmd.flags);
			return;
		case "token":
			await runToken(cmd.flags);
			return;
		case "login":
			await runLogin(cmd.flags);
			return;
		case "logout":
			await runLogout(cmd.flags);
			return;
		case "import":
			await runImport(cmd.flags);
			return;
		case "migrate":
			await runMigrate(cmd.flags);
			return;
		case "status":
			await runStatus(cmd.flags);
			return;
		case "list":
			await runList(cmd.flags);
			return;
		default: {
			// Exhaustive check.
			const _exhaustive: never = cmd.action;
			throw new Error(`Unknown auth-broker action: ${String(_exhaustive)}`);
		}
	}
}

export { ACTIONS as AUTH_BROKER_ACTIONS };

// Touch `$` so Bun's tree-shaker keeps the shell helper imported (used by future verbs).
void $;
