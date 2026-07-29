/**
 * report_tool_issue — automated QA tool for tracking unexpected tool behavior.
 *
 * Enabled by default; gated behind PI_AUTO_QA=1 / `dev.autoqa` so a user
 * who flips the setting off short-circuits injection entirely.
 * Always injected into every agent (including subagents) regardless of tool selection.
 * Records grievances to a local SQLite database; never throws.
 *
 * Before the first record lands, the user's consent is checked. If they've
 * never been asked (`dev.autoqa.consent === "unset"`) the process-global
 * consent handler — wired by `InteractiveMode` to a Yes/No popup — is
 * invoked exactly once and the decision is persisted. Subsequent calls
 * (including from subagents) read the cached decision without prompting.
 *
 * When the user grants consent, push is active only when
 * `dev.autoqaPush.endpoint` is configured. Each
 * insert schedules a background flush that POSTs pending rows and deletes
 * them on HTTP 2xx. `PI_AUTO_QA_PUSH=1` forces push in non-interactive
 * environments where the consent dialog never fires. Tool execution is
 * never blocked on the network and never throws.
 */
import { Database } from "bun:sqlite";
import type { AgentTool } from "@pk-nerdsaver-ai/pi-agent-core";
import type { FetchImpl } from "@pk-nerdsaver-ai/pi-ai";
import { $env, $flag, getAutoQaDbDir, getInstallId, logger, VERSION } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";
import type { Settings } from "..";
import type { ToolSession } from "./index";

function buildReportToolIssueParams(activeBuiltinNames: readonly string[]) {
	// Enum gives the model a tight schema; the runtime check in `execute` is the
	// source of truth (handles models that ignore the enum and the empty-list
	// fallback used by call sites that don't know the active set yet).
	const toolSchema = activeBuiltinNames.length > 0 ? type.enumerated(...activeBuiltinNames) : type("string");
	return type({
		tool: toolSchema.describe("tool name"),
		report: type("string").describe(
			"unexpected behavior; generic, NEVER PII (paths, file contents, identifiers, prompt text)",
		),
	});
}

export function isAutoQaEnabled(settings?: Settings): boolean {
	return $flag("PI_AUTO_QA", !!settings?.get("dev.autoqa"));
}

// ───────────────────────────────────────────────────────────────────────────
// Consent gate
// ───────────────────────────────────────────────────────────────────────────

/**
 * Resolver for the user's "share grievances?" consent.
 *
 * Return values:
 *   - `true`  — user agreed; record + ship for this run and persist.
 *   - `false` — user declined; suppress for this run and persist.
 *   - `null`  — user dismissed the dialog (ESC, click-away, …) without
 *               picking an option. The decision is NOT cached or persisted,
 *               so the next `report_tool_issue` invocation re-prompts.
 *
 * Persistence is the tool's job (so subagent invocations can persist into
 * the disk-backed `Settings` instance the host registered alongside the
 * handler), not the handler's. Implementations live in hosts that have UI
 * affordances — today only `InteractiveMode`. When no handler is
 * registered (CLI subcommands, tests, non-interactive runs) consent
 * defaults to `false` — the explicit "don't collect by default" stance.
 */
export type AutoQaConsentHandler = () => Promise<boolean | null>;

let consentHandler: AutoQaConsentHandler | null = null;
/**
 * Persistent settings instance supplied by the consent-handler registrant.
 * Subagents have in-memory `Settings` snapshots that don't write to disk;
 * we persist the decision through this disk-backed reference so a grant
 * survives across runs even when triggered from a subagent tool call.
 */
let persistentConsentSettings: Settings | null = null;
/**
 * Process-global cache of the resolved consent decision. Survives across
 * subagent boundaries (subagents share this module instance), so a grant
 * in the parent applies immediately to children — including children that
 * spawned BEFORE the grant and would otherwise see a stale snapshot of
 * `dev.autoqa.consent` in their isolated `Settings`.
 *
 * `null` = never asked, never cached.
 */
let cachedConsent: boolean | null = null;
/**
 * Single-flight in-flight consent request. While the dialog is open, every
 * concurrent `report_tool_issue` call (main + every subagent) awaits this
 * promise instead of stacking duplicate popups.
 */
let consentInFlight: Promise<boolean> | null = null;

/**
 * Register the consent handler and the persistent {@link Settings} instance
 * the decision should be written to. Passing `null` clears the handler
 * (e.g. on `InteractiveMode` teardown). Re-registration is authoritative.
 */
export function setAutoQaConsentHandler(
	handler: AutoQaConsentHandler | null,
	persistentSettings: Settings | null = null,
): void {
	consentHandler = handler;
	persistentConsentSettings = persistentSettings;
}

/** Test-only: clear consent cache + handler. Never call from production code. */
export function __resetAutoQaConsentForTests(): void {
	consentHandler = null;
	persistentConsentSettings = null;
	cachedConsent = null;
	consentInFlight = null;
}

function readPersistedConsent(settings: Settings | undefined): boolean | null {
	if (!settings) return null;
	const stored = settings.get("dev.autoqa.consent");
	if (stored === "granted") return true;
	if (stored === "denied") return false;
	return null;
}

function persistConsent(localSettings: Settings | undefined, granted: boolean): void {
	const value = granted ? "granted" : "denied";
	// Write on every settings instance we know about. The local one keeps
	// the in-memory snapshot consistent for the current subagent; the
	// persistent one (registered by the host) is what actually lands on disk.
	for (const target of [localSettings, persistentConsentSettings]) {
		if (!target) continue;
		try {
			target.set("dev.autoqa.consent", value);
		} catch (error) {
			logger.debug("autoqa consent persist failed", { error: String(error) });
		}
	}
}

/**
 * Resolve the user's consent for `report_tool_issue` grievances.
 *
 * Precedence (highest first):
 *   1. Process-global cache (set on first successful resolution).
 *   2. Persistent setting (`dev.autoqa.consent` on the supplied `Settings`).
 *   3. Persistent setting on the registered host `Settings`.
 *   4. Consent handler popup (single-flight; persists the answer).
 *   5. Default-deny when no handler is registered.
 *
 * Never throws — handler errors degrade to "denied for this call" without
 * caching, so a subsequent invocation can re-prompt instead of being
 * permanently locked into the false branch.
 */
export async function resolveAutoQaConsent(settings: Settings | undefined): Promise<boolean> {
	if (cachedConsent !== null) return cachedConsent;
	const persisted = readPersistedConsent(settings) ?? readPersistedConsent(persistentConsentSettings ?? undefined);
	if (persisted !== null) {
		cachedConsent = persisted;
		return persisted;
	}
	if (!consentHandler) return false;
	if (consentInFlight) return consentInFlight;
	const handler = consentHandler;
	consentInFlight = (async () => {
		try {
			const granted = await handler();
			if (granted === null) {
				// User dismissed the dialog (ESC) without picking. Treat as
				// "skip this call" but don't cache or persist — the next
				// invocation gets to re-prompt so a stray ESC isn't a
				// permanent opt-out.
				return false;
			}
			cachedConsent = granted;
			persistConsent(settings, granted);
			return granted;
		} catch (error) {
			logger.warn("autoqa consent handler threw", { error: String(error) });
			return false;
		} finally {
			consentInFlight = null;
		}
	})();
	return consentInFlight;
}

let cachedDb: Database | null = null;

/**
 * Open (or return the cached handle for) the auto-QA SQLite database at
 * `~/.ompk/agent/autoqa.db`. Idempotently runs schema creation, the
 * `pushed`-column migration, and index setup so every consumer — tool
 * execute path, manual `omp grievances push`, future debug scripts —
 * sees the same prepared schema. Returns `null` only on a hard open
 * failure (filesystem permissions, etc.); a missing file is created.
 *
 * Exported because the `omp grievances` CLI handlers need the migrated
 * handle too — having a second `openDb` in the CLI led to the column
 * never being added on the manual-push path.
 */
export function openAutoQaDb(): Database | null {
	if (cachedDb) return cachedDb;
	try {
		const db = new Database(getAutoQaDbDir());
		// Install the busy handler BEFORE any lock-taking statement. See #2421.
		db.run("PRAGMA busy_timeout = 5000");
		db.run(`
			PRAGMA journal_mode=WAL;
			PRAGMA synchronous=NORMAL;
			CREATE TABLE IF NOT EXISTS grievances (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				model TEXT NOT NULL,
				version TEXT NOT NULL,
				tool TEXT NOT NULL,
				report TEXT NOT NULL,
				pushed INTEGER NOT NULL DEFAULT 0
			);
		`);
		// Migration: pre-`pushed` databases get the column tacked on. Existing
		// rows default to `0` (unpushed), so legacy grievances from before the
		// consent + push pipeline went live get swept up by the next flush —
		// exactly the behaviour we want for users who just granted consent.
		const cols = db.prepare("PRAGMA table_info(grievances)").all() as Array<{ name: string }>;
		if (!cols.some(c => c.name === "pushed")) {
			db.run("ALTER TABLE grievances ADD COLUMN pushed INTEGER NOT NULL DEFAULT 0");
		}
		// Speed up the per-batch `WHERE pushed = 0` scan that drives the flush
		// loop. Without the index every batch becomes a full table scan once
		// pushed rows dominate the table.
		db.run("CREATE INDEX IF NOT EXISTS grievances_pushed_idx ON grievances(pushed, id)");
		cachedDb = db;
		return db;
	} catch {
		return null;
	}
}

// ───────────────────────────────────────────────────────────────────────────
// Backend push
// ───────────────────────────────────────────────────────────────────────────

export interface FlushResult {
	pushed: number;
	ok: boolean;
	skipped?: boolean;
}

/**
 * Optional per-flush controls. Used by `omp grievances push` to surface
 * progress to a TTY and to skip the user-facing consent gate (manual
 * pushes are the user's explicit intent, not a side effect of a tool call).
 */
export interface FlushOptions {
	/**
	 * Skip the `dev.autoqa.consent === "granted"` gate in
	 * {@link resolvePushConfig}. Endpoint configuration is still required.
	 * Reserved for explicit user-driven pushes (CLI `grievances push`,
	 * future debug recipes); never set from the tool's auto-flush path.
	 */
	bypassConsent?: boolean;
	/**
	 * Fetch implementation for the push POST. Defaults to global fetch.
	 */
	fetch?: FetchImpl;
	/**
	 * Fires once at the start of the loop with the snapshot count of
	 * unpushed rows. Subsequent inserts won't be reflected (the count is
	 * a planning hint for progress reporters, not a live total).
	 */
	onStart?: (totalUnpushed: number) => void;
	/**
	 * Fires after every successfully shipped batch with the running pushed
	 * count. Reporters compare against the `totalUnpushed` they saw in
	 * `onStart` to advance their bar.
	 */
	onProgress?: (pushedSoFar: number) => void;
}

interface PushConfig {
	endpoint: string;
	token: string | undefined;
}

const FLUSH_TIMEOUT_MS = 5_000;
const FAILURE_COOLDOWN_MS = 30_000;
/**
 * Per-request batch size. The worker loops until no unpushed rows remain,
 * shipping `FLUSH_BATCH_SIZE` rows per POST. Tunes the trade-off between
 * request count and request size — 50 keeps each payload well under the
 * default `maxBody` limit on the autoqa collector while letting a
 * realistic backlog (a few hundred legacy rows on first flush after the
 * consent grant) drain in single-digit requests.
 */
const FLUSH_BATCH_SIZE = 50;

let inFlightFlush: Promise<FlushResult> | null = null;
let lastFailureAt = 0;

/** Test-only: clear single-flight + cooldown state. Never call from production code. */
export function __resetAutoQaFlushStateForTests(): void {
	inFlightFlush = null;
	lastFailureAt = 0;
}

function envOverrideString(name: string): string | undefined {
	const value = $env[name];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function resolvePushConfig(settings: Settings | undefined, bypassConsent: boolean): PushConfig | null {
	if (!isAutoQaEnabled(settings)) return null;

	// Consent IS the push opt-in for the auto-flush path. `bypassConsent`
	// covers explicit user-driven pushes (`omp grievances push`) where the
	// user clearly intends to ship regardless of dialog state. The
	// `PI_AUTO_QA_PUSH` env flag stays as a CI/headless override too.
	if (!bypassConsent) {
		const consented = settings?.get("dev.autoqa.consent") === "granted";
		if (!consented && !$flag("PI_AUTO_QA_PUSH")) return null;
	}

	const endpoint = envOverrideString("PI_AUTO_QA_PUSH_URL") ?? settings?.get("dev.autoqaPush.endpoint");
	if (!endpoint || endpoint.trim().length === 0) return null;

	const token = envOverrideString("PI_AUTO_QA_PUSH_TOKEN") ?? settings?.get("dev.autoqaPush.token");
	return { endpoint: endpoint.trim(), token: token && token.length > 0 ? token : undefined };
}

interface GrievanceRow {
	id: number;
	model: string;
	version: string;
	tool: string;
	report: string;
}

async function performFlush(db: Database, config: PushConfig, options: FlushOptions = {}): Promise<FlushResult> {
	const selectStmt = db.prepare(
		"SELECT id, model, version, tool, report FROM grievances WHERE pushed = 0 ORDER BY id ASC LIMIT ?",
	);
	// Planning snapshot — fires once so progress reporters can size their bar.
	// Mid-flight inserts are NOT folded in (the worker drains them too, but
	// the progress bar treats the initial backlog as the denominator).
	if (options.onStart) {
		const totalRow = db.prepare("SELECT COUNT(*) AS n FROM grievances WHERE pushed = 0").get() as { n: number };
		options.onStart(totalRow.n);
	}
	const fetchImpl = options.fetch ?? fetch;
	let totalPushed = 0;
	for (;;) {
		const rows = selectStmt.all(FLUSH_BATCH_SIZE) as GrievanceRow[];
		if (rows.length === 0) return { pushed: totalPushed, ok: true };

		const body = JSON.stringify({
			agent: { name: "omp", version: VERSION },
			installId: getInstallId(),
			// Coarse host fingerprint for triage — `darwin`/`linux`/`win32` +
			// `arm64`/`x64`. Useful for "is this bug arch-specific?" without
			// leaking the user's machine name (the old payload sent
			// `os.hostname()` verbatim, which trivially deanonymises users).
			platform: process.platform,
			arch: process.arch,
			entries: rows,
		});
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (config.token) headers.authorization = `Bearer ${config.token}`;

		let response: Response;
		try {
			response = await fetchImpl(config.endpoint, {
				method: "POST",
				headers,
				body,
				signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
			});
		} catch (error) {
			lastFailureAt = Date.now();
			logger.warn("autoqa push failed", {
				endpoint: config.endpoint,
				error: String(error),
				batchSize: rows.length,
				pushedSoFar: totalPushed,
			});
			return { pushed: totalPushed, ok: false };
		}

		if (!response.ok) {
			lastFailureAt = Date.now();
			logger.warn("autoqa push failed", {
				endpoint: config.endpoint,
				status: response.status,
				batchSize: rows.length,
				pushedSoFar: totalPushed,
			});
			return { pushed: totalPushed, ok: false };
		}

		// Mark just this batch — never touch ids the SELECT didn't return so a
		// concurrent insert that landed mid-flight isn't claimed-as-shipped on
		// our behalf. `id IN (?, ?, …)` rather than a range so a non-contiguous
		// batch (after partial fills, retries, etc.) still flips exactly what
		// we sent.
		const ids = rows.map(r => r.id);
		const placeholders = ids.map(() => "?").join(",");
		db.prepare(`UPDATE grievances SET pushed = 1 WHERE id IN (${placeholders})`).run(...ids);
		totalPushed += rows.length;
		options.onProgress?.(totalPushed);
		// Loop continues; the next SELECT picks up the next batch (or returns
		// empty, exiting the loop).
	}
}

/**
 * Flush queued grievances to the configured backend.
 *
 * Single-flight: concurrent callers share the in-flight promise. After a
 * failed push, retries are skipped for {@link FAILURE_COOLDOWN_MS} ms.
 * Never throws — all errors are caught and routed to the logger.
 */
export async function flushGrievances(
	db?: Database,
	settings?: Settings,
	options: FlushOptions = {},
): Promise<FlushResult> {
	const config = resolvePushConfig(settings, options.bypassConsent === true);
	if (!config) return { pushed: 0, ok: false, skipped: true };

	// `bypassConsent` is the user's explicit "ship NOW" intent — skip the
	// 30s cooldown window so they're not stuck looking at "skipped" after a
	// transient failure. Auto-flush calls still cool off.
	const bypass = options.bypassConsent === true;
	if (!bypass && inFlightFlush) return inFlightFlush;

	if (!bypass && lastFailureAt > 0 && Date.now() - lastFailureAt < FAILURE_COOLDOWN_MS) {
		return { pushed: 0, ok: false, skipped: true };
	}

	const handle = db ?? openAutoQaDb();
	if (!handle) return { pushed: 0, ok: false, skipped: true };

	const promise = (async () => {
		try {
			return await performFlush(handle, config, options);
		} catch (error) {
			lastFailureAt = Date.now();
			logger.warn("autoqa push failed", { endpoint: config.endpoint, error: String(error) });
			return { pushed: 0, ok: false };
		}
	})();

	if (!bypass) inFlightFlush = promise;
	try {
		return await promise;
	} finally {
		if (!bypass) inFlightFlush = null;
	}
}

export function createReportToolIssueTool(session: ToolSession, activeBuiltinNames: readonly string[] = []): AgentTool {
	const getModel = () => session.getActiveModelString?.() ?? "unknown";
	// Snapshotted at construction time. The model's enum is built from the same
	// snapshot; mid-session drift (extensions registering later, etc.) is caught
	// by the silent-drop guard below.
	const allowedToolNames = new Set(activeBuiltinNames);

	return {
		name: "report_tool_issue",
		label: "Report Tool Issue",
		strict: false,
		approval: "write",
		description: "Report unexpected tool behavior for automated QA tracking.",
		parameters: buildReportToolIssueParams(activeBuiltinNames),
		intent: "omit",
		async execute(_toolCallId, rawParams) {
			// Save is unconditional: the row lives in the user's own SQLite
			// at ~/.ompk/agent/autoqa.db regardless of consent — they always
			// own their local data and can inspect or wipe it via `omp grievances`.
			// Consent only gates whether the row is *shipped* to the shared
			// backend; that decision rides on `dev.autoqa.consent` and is
			// enforced inside `flushGrievances` via `resolvePushConfig`.
			try {
				const params = rawParams as { tool: string; report: string };
				// Some models emit `proxy_<name>` for tools routed through a
				// passthrough wrapper. Strip the prefix before allowlist check so
				// `proxy_read` lands as a report against `read`, not a silent drop.
				const canonicalTool = params.tool.startsWith("proxy_") ? params.tool.slice("proxy_".length) : params.tool;
				// Silently drop reports targeting tools that aren't shipped built-ins
				// (MCP servers, extensions that overrode a built-in name, typos).
				// Not the model's fault — no error, no DB row, just acknowledge.
				// Empty allowlist means the factory was called without a known active
				// set, so behave as before and record everything.
				if (allowedToolNames.size > 0 && !allowedToolNames.has(canonicalTool)) {
					return { content: [{ type: "text", text: "Noted, thanks!" }] };
				}
				const db = openAutoQaDb();
				if (db) {
					db.prepare("INSERT INTO grievances (model, version, tool, report) VALUES (?, ?, ?, ?)").run(
						getModel(),
						VERSION,
						canonicalTool,
						params.report,
					);
					// Fire-and-forget background pipeline:
					//   1. Trigger the consent popup if it hasn't been answered
					//      (single-flight inside `resolveAutoQaConsent`; subagents
					//      share the same module-level state).
					//   2. Attempt a flush — `resolvePushConfig` no-ops when consent
					//      isn't granted, so a "no" leaves the row local for later
					//      `omp grievances push` or a future consent change.
					// Tool execution returns immediately; the model never waits
					// on the dialog.
					void (async () => {
						try {
							await resolveAutoQaConsent(session.settings);
							await flushGrievances(db, session.settings);
						} catch (error) {
							logger.debug("autoqa post-insert pipeline failed", { error: String(error) });
						}
					})();
				}
			} catch (error) {
				logger.error("Failed to record tool issue", { error });
			}
			return {
				content: [{ type: "text", text: "Noted, thanks!" }],
			};
		},
	};
}
