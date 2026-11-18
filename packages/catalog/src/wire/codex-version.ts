/**
 * Runtime-resolved OpenAI Codex client version.
 *
 * The ChatGPT backend gates `/models` and `/responses` on the client version
 * without rejecting old clients (see {@link CODEX_CLIENT_VERSION}), so a stale
 * pin silently hides new SKUs. Unlike Claude Code there is no "version too old"
 * error to adopt from, so the version tracks the `latest` npm dist-tag of
 * `@openai/codex` instead:
 *
 *  - The first read in a process loads `<agent-dir>/codex-client-version.json`
 *    synchronously and keeps that value for the rest of the process. The
 *    version keys the model-cache namespace and must not move mid-process.
 *  - When the record is older than {@link REFRESH_INTERVAL_MS}, a background
 *    fetch rewrites it; the next process starts with the new version.
 *  - The result never drops below the pinned {@link CODEX_CLIENT_VERSION}.
 *
 * `PI_AI_CODEX_CLIENT_VERSION` pins the version explicitly and disables both
 * the disk record and the network refresh; so does running under `bun test`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import { CODEX_CLIENT_VERSION } from "./codex";

const NPM_LATEST_URL = "https://registry.npmjs.org/@openai/codex/latest";
const RECORD_FILE = "codex-client-version.json";
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

interface VersionRecord {
	version: string;
	checkedAt: number;
}

let resolvedVersion: string | null = null;
let refreshStarted = false;

function compareSemver(a: string, b: string): number {
	const pa = SEMVER_PATTERN.exec(a);
	const pb = SEMVER_PATTERN.exec(b);
	if (!pa || !pb) return 0;
	for (let i = 1; i <= 3; i++) {
		const diff = Number(pa[i]) - Number(pb[i]);
		if (diff !== 0) return diff;
	}
	return 0;
}

function newerOf(candidate: string | undefined): string {
	if (!candidate || !SEMVER_PATTERN.test(candidate)) return CODEX_CLIENT_VERSION;
	return compareSemver(candidate, CODEX_CLIENT_VERSION) > 0 ? candidate : CODEX_CLIENT_VERSION;
}

function isDynamicResolutionDisabled(): boolean {
	return Boolean(process.env.PI_AI_CODEX_CLIENT_VERSION) || process.env.NODE_ENV === "test";
}

function recordPath(): string {
	return path.join(getAgentDir(), RECORD_FILE);
}

function readRecord(): VersionRecord | null {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(recordPath(), "utf-8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		const version = Reflect.get(parsed, "version");
		const checkedAt = Reflect.get(parsed, "checkedAt");
		if (typeof version !== "string" || typeof checkedAt !== "number") return null;
		return { version, checkedAt };
	} catch {
		return null;
	}
}

async function refreshRecord(): Promise<void> {
	try {
		const response = await fetch(NPM_LATEST_URL, {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return;
		const data: unknown = await response.json();
		const version = typeof data === "object" && data !== null ? Reflect.get(data, "version") : undefined;
		if (typeof version !== "string" || !SEMVER_PATTERN.test(version)) return;
		const record: VersionRecord = { version, checkedAt: Date.now() };
		const target = recordPath();
		const temp = `${target}.${process.pid}.tmp`;
		await Bun.write(temp, JSON.stringify(record));
		fs.renameSync(temp, target);
	} catch (error) {
		logger.debug("codex client version refresh failed", { error: String(error) });
	}
}

/**
 * Codex client version to present on the wire and to key the model cache:
 * `PI_AI_CODEX_CLIENT_VERSION` → latest npm release recorded on disk (when newer
 * than the pin) → {@link CODEX_CLIENT_VERSION}. Stable for the life of the process.
 */
export function getCodexClientVersion(): string {
	const override = process.env.PI_AI_CODEX_CLIENT_VERSION;
	if (override) return override;
	if (resolvedVersion !== null) return resolvedVersion;
	if (isDynamicResolutionDisabled()) {
		resolvedVersion = CODEX_CLIENT_VERSION;
		return resolvedVersion;
	}
	const record = readRecord();
	resolvedVersion = newerOf(record?.version);
	if (!refreshStarted && (!record || Date.now() - record.checkedAt > REFRESH_INTERVAL_MS)) {
		refreshStarted = true;
		void refreshRecord();
	}
	return resolvedVersion;
}
