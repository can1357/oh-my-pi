import { type BridgeLogger, consoleBridgeLogger } from "./logger";
import type { ScreenpipeFrameRow } from "./types";

export interface ScreenpipeClientOptions {
	readonly baseUrl?: string;
	readonly fetchImpl?: typeof fetch;
	/** Abort a stalled /raw_sql request after this many milliseconds. Default 30s. */
	readonly requestTimeoutMs?: number;
	readonly logger?: BridgeLogger;
}

export interface FetchRedactedFramesOptions {
	readonly sinceFrameId: number;
	readonly limit: number;
}

/**
 * Reads already-redacted frame metadata from a local screenpipe instance via
 * its read-only `/raw_sql` endpoint. Every text surface a frame actually
 * carries must have its matching text-redaction watermark, and a frame with a
 * snapshot must have the image-redaction watermark too — enforced in SQL,
 * then re-checked in `parseFrameRow` since screenpipe is a separate,
 * untrusted process from this bridge's point of view.
 */
export class ScreenpipeClient {
	#baseUrl: string;
	#fetchImpl: typeof fetch;
	#requestTimeoutMs: number;
	#logger: BridgeLogger;

	constructor(options: ScreenpipeClientOptions = {}) {
		this.#baseUrl = (options.baseUrl ?? "http://127.0.0.1:3030").replace(/\/+$/, "");
		this.#fetchImpl = options.fetchImpl ?? fetch;
		this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
		if (!Number.isSafeInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs <= 0)
			throw new Error("requestTimeoutMs must be a positive integer");
		this.#logger = options.logger ?? consoleBridgeLogger;
	}

	async fetchRedactedFrames(options: FetchRedactedFramesOptions): Promise<readonly ScreenpipeFrameRow[]> {
		const { sinceFrameId, limit } = options;
		if (!Number.isSafeInteger(sinceFrameId) || sinceFrameId < 0)
			throw new Error("sinceFrameId must be a non-negative integer");
		if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000)
			throw new Error("limit must be a positive integer no greater than 10000");

		const query = buildRedactedFramesQuery(sinceFrameId, limit);
		const response = await this.#fetchImpl(`${this.#baseUrl}/raw_sql`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query }),
			signal: AbortSignal.timeout(this.#requestTimeoutMs),
		});
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(`screenpipe /raw_sql returned ${response.status}: ${body.slice(0, 500)}`);
		}
		const payload: unknown = await response.json();
		if (!Array.isArray(payload)) throw new Error("screenpipe /raw_sql returned a non-array payload");
		const frames = payload.map(parseFrameRow).filter((row): row is ScreenpipeFrameRow => row !== undefined);
		if (frames.length < payload.length) {
			this.#logger.warn("screenpipe bridge dropped rows that failed redaction re-validation", {
				droppedRowCount: payload.length - frames.length,
				fetchedRowCount: payload.length,
			});
		}
		return frames;
	}
}

function buildRedactedFramesQuery(sinceFrameId: number, limit: number): string {
	return `
		SELECT
			id, timestamp, device_name, app_name, window_name, browser_url, focused,
			snapshot_path,
			full_text_redacted_at, accessibility_redacted_at, accessibility_tree_redacted_at,
			window_name_redacted_at, browser_url_redacted_at, text_json_redacted_at,
			image_redacted_at,
			CASE WHEN full_text IS NOT NULL AND full_text != '' THEN 1 ELSE 0 END AS has_full_text,
			CASE WHEN accessibility_text IS NOT NULL AND accessibility_text != '' THEN 1 ELSE 0 END AS has_accessibility_text,
			CASE WHEN accessibility_tree_json IS NOT NULL AND accessibility_tree_json != '' THEN 1 ELSE 0 END AS has_accessibility_tree,
			CASE WHEN text_json IS NOT NULL AND text_json != '' THEN 1 ELSE 0 END AS has_text_json
		FROM frames
		WHERE id > ${sinceFrameId}
			AND (full_text IS NULL OR full_text = '' OR full_text_redacted_at IS NOT NULL)
			AND (accessibility_text IS NULL OR accessibility_text = '' OR accessibility_redacted_at IS NOT NULL)
			AND (accessibility_tree_json IS NULL OR accessibility_tree_json = '' OR accessibility_tree_redacted_at IS NOT NULL)
			AND (window_name IS NULL OR window_name = '' OR window_name_redacted_at IS NOT NULL)
			AND (browser_url IS NULL OR browser_url = '' OR browser_url_redacted_at IS NOT NULL)
			AND (text_json IS NULL OR text_json = '' OR text_json_redacted_at IS NOT NULL)
			AND (snapshot_path IS NULL OR snapshot_path = '' OR image_redacted_at IS NOT NULL)
		ORDER BY id ASC
		LIMIT ${limit}
	`.trim();
}

/** Re-validates the redaction gates the SQL WHERE clause already applied; drops any row that fails. */
function parseFrameRow(value: unknown): ScreenpipeFrameRow | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const row = value as Record<string, unknown>;
	if (typeof row.id !== "number" || typeof row.timestamp !== "string" || typeof row.device_name !== "string")
		return undefined;
	const timestamp = normalizeSqliteTimestamp(row.timestamp);
	if (timestamp === undefined) return undefined;

	const hasFullText = row.has_full_text === 1;
	const hasAccessibilityText = row.has_accessibility_text === 1;
	const hasAccessibilityTree = row.has_accessibility_tree === 1;
	const hasTextJson = row.has_text_json === 1;
	// /raw_sql may serialize SQL NULL as "" for TEXT columns; treat both as absent.
	const appName = optionalText(row.app_name);
	const windowName = optionalText(row.window_name);
	const browserUrl = optionalText(row.browser_url);
	const snapshotPath = optionalText(row.snapshot_path);

	// /raw_sql can serialize SQL NULL for INTEGER columns as 0, so a watermark
	// only counts when it is a positive epoch — 0 must read as "never redacted".
	if (hasFullText && !isWatermark(row.full_text_redacted_at)) return undefined;
	if (hasAccessibilityText && !isWatermark(row.accessibility_redacted_at)) return undefined;
	if (hasAccessibilityTree && !isWatermark(row.accessibility_tree_redacted_at)) return undefined;
	if (hasTextJson && !isWatermark(row.text_json_redacted_at)) return undefined;
	if (windowName !== null && !isWatermark(row.window_name_redacted_at)) return undefined;
	if (browserUrl !== null && !isWatermark(row.browser_url_redacted_at)) return undefined;
	if (snapshotPath !== null && !isWatermark(row.image_redacted_at)) return undefined;

	return {
		id: row.id,
		timestamp,
		device_name: row.device_name,
		app_name: appName,
		window_name: windowName,
		browser_url: browserUrl,
		focused: typeof row.focused === "number" ? row.focused : null,
		snapshot_path: snapshotPath,
		full_text_redacted_at: optionalNumber(row.full_text_redacted_at),
		accessibility_redacted_at: optionalNumber(row.accessibility_redacted_at),
		accessibility_tree_redacted_at: optionalNumber(row.accessibility_tree_redacted_at),
		window_name_redacted_at: optionalNumber(row.window_name_redacted_at),
		browser_url_redacted_at: optionalNumber(row.browser_url_redacted_at),
		text_json_redacted_at: optionalNumber(row.text_json_redacted_at),
		image_redacted_at: optionalNumber(row.image_redacted_at),
		has_full_text: hasFullText ? 1 : 0,
		has_accessibility_text: hasAccessibilityText ? 1 : 0,
		has_accessibility_tree: hasAccessibilityTree ? 1 : 0,
		has_text_json: hasTextJson ? 1 : 0,
	};
}

function optionalText(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

function optionalNumber(value: unknown): number | null {
	return typeof value === "number" ? value : null;
}

function isWatermark(value: unknown): boolean {
	return typeof value === "number" && value > 0;
}

/**
 * SQLite may store timestamps as "YYYY-MM-DD HH:MM:SS[.fff]" with no zone;
 * Date.parse would read that as LOCAL time and skew every window. Screenpipe
 * writes UTC, so a zoneless timestamp is normalized to an explicit-UTC ISO
 * string. Returns undefined for unparseable input.
 */
function normalizeSqliteTimestamp(raw: string): string | undefined {
	let candidate = raw.trim();
	if (!candidate) return undefined;
	if (candidate.includes(" ") && !candidate.includes("T")) candidate = candidate.replace(" ", "T");
	if (!/(?:z|[+-]\d{2}:?\d{2})$/i.test(candidate)) candidate = `${candidate}Z`;
	const parsed = Date.parse(candidate);
	if (!Number.isFinite(parsed)) return undefined;
	return new Date(parsed).toISOString();
}
