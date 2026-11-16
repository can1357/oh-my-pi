import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $env, getAntigravityCliDir, isRecord, ptree } from "@oh-my-pi/pi-utils";
import { quotaTierFor } from "@oh-my-pi/pi-catalog/compat/behavior";
import { agyCredentialEnv, stageAgyCredentials } from "../providers/antigravity-cli/credentials";
import type {
	CredentialRankingContext,
	CredentialRankingStrategy,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageWindow,
} from "../usage";
import { buildUsageAmount, HOUR_MS, parseIsoTimestamp, usageStatus, WEEK_MS } from "./shared";

const PROVIDER = "antigravity-cli";
const COMMAND_TIMEOUT_MS = 30_000;
const CAPTURE_PREFIX = "omp-agy-usage-";

interface AgyUsageRow {
	group: string;
	window: string;
	remainingFraction: number;
	resetsAt?: number;
}

function slug(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/gu, "-")
			.replace(/^-+|-+$/gu, "") || "usage"
	);
}

function parsePercent(value: string): number | undefined {
	if (!/^\d+(?:\.\d+)?%$/u.test(value)) return undefined;
	const percent = Number(value.slice(0, -1));
	return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent / 100 : undefined;
}

/** Parse the tab-separated quota rows printed by `agy -p /usage`. */
export function parseAgyUsage(output: string): AgyUsageRow[] {
	const rows: AgyUsageRow[] = [];
	for (const line of output.split(/\r?\n/u)) {
		const columns = line
			.trim()
			.split("\t")
			.map(value => value.trim());
		if (columns.length < 3) continue;
		const [group, window, percent, reset] = columns;
		const remainingFraction = parsePercent(percent ?? "");
		if (!group || !window || remainingFraction === undefined) continue;
		const resetsAt = reset ? parseIsoTimestamp(reset) : undefined;
		rows.push({ group, window, remainingFraction, ...(resetsAt !== undefined ? { resetsAt } : {}) });
	}
	return rows;
}

function usageWindow(label: string): UsageWindow {
	const normalized = label.toLowerCase();
	if (normalized.includes("weekly") || normalized.includes("7 day")) {
		return { id: "weekly", label: "Weekly", durationMs: WEEK_MS };
	}
	if (normalized.includes("five hour") || normalized.includes("5h")) {
		return { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS };
	}
	return { id: slug(label), label };
}
function counterKey(group: string): string {
	const normalized = group.toLowerCase();
	if (normalized.includes("argon")) return "gemini-argon";
	if (normalized.includes("claude") || normalized.includes("gpt")) return "claude-gpt";
	return "gemini";
}

function toLimit(row: AgyUsageRow, params: UsageFetchParams): UsageLimit {
	const window = usageWindow(row.window);
	const usedFraction = 1 - row.remainingFraction;
	const amount = buildUsageAmount({
		used: usedFraction * 100,
		limit: 100,
		remaining: row.remainingFraction * 100,
		usedFraction,
		unit: "percent",
	});
	return {
		id: `${PROVIDER}:${counterKey(row.group)}:${window.id}`,
		label: row.group,
		scope: {
			provider: PROVIDER,
			...(params.credential.accountId ? { accountId: params.credential.accountId } : {}),
			windowId: window.id,
		},
		window: { ...window, ...(row.resetsAt !== undefined ? { resetsAt: row.resetsAt } : {}) },
		amount,
		status: usageStatus(usedFraction),
	};
}

function buildReport(params: UsageFetchParams, rows: AgyUsageRow[]): UsageReport {
	const limits = rows.map(row => toLimit(row, params));
	limits.sort((a, b) => (a.amount.remainingFraction ?? 1) - (b.amount.remainingFraction ?? 1));
	return {
		provider: PROVIDER,
		fetchedAt: Date.now(),
		limits,
		metadata: {
			endpoint: "agy /usage",
			...(params.credential.email ? { email: params.credential.email } : {}),
			...(params.credential.accountId ? { accountId: params.credential.accountId } : {}),
		},
		raw: rows,
	};
}

function counterLimits(report: UsageReport, key: string): UsageLimit[] {
	const prefix = `${report.provider}:${key}:`;
	return report.limits.filter(limit => limit.id.startsWith(prefix));
}

function modelCounterKey(context: CredentialRankingContext | undefined): string | undefined {
	return context?.modelId ? quotaTierFor(PROVIDER, context.modelId) : undefined;
}

export const antigravityCliRankingStrategy: CredentialRankingStrategy = {
	findWindowLimits(report, context) {
		const key = modelCounterKey(context);
		const limits = key ? counterLimits(report, key) : report.limits;
		return {
			primary: limits.find(limit => limit.window?.id === "5h"),
			secondary: limits.find(limit => limit.window?.id === "weekly"),
		};
	},
	scopeLimits(report, context) {
		const key = modelCounterKey(context);
		return key ? counterLimits(report, key) : [];
	},
	blockScope(context) {
		return `counter:${modelCounterKey(context) ?? "unknown"}`;
	},
	healableBlockScopes(report) {
		const keys = new Set(
			report.limits.map(limit => limit.id.split(":")[1]).filter((key): key is string => Boolean(key)),
		);
		return [...keys].map(key => ({ blockScope: `counter:${key}`, limits: counterLimits(report, key) }));
	},
	windowDefaults: { primaryMs: 5 * HOUR_MS, secondaryMs: WEEK_MS },
};

async function existingAgyBinary(): Promise<string | undefined> {
	const override = $env.PI_AGY_PATH;
	if (override) return override;
	const directory = path.join(getAntigravityCliDir(), "bin");
	try {
		const record: unknown = await Bun.file(path.join(directory, "install.json")).json();
		if (!isRecord(record) || typeof record.version !== "string") return undefined;
		const binary = path.join(directory, record.version, process.platform === "win32" ? "agy.exe" : "agy");
		return (await Bun.file(binary).exists()) ? binary : undefined;
	} catch {
		return undefined;
	}
}

/** Probe quota through the official CLI; the temporary credential directory is removed afterwards. */
export async function fetchAgyUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	const credential = params.credential;
	if (
		credential.type !== "oauth" ||
		!credential.accessToken ||
		!credential.refreshToken ||
		credential.expiresAt === undefined
	) {
		return null;
	}
	let directory: string | undefined;
	try {
		const binary = await existingAgyBinary();
		if (!binary) return null;
		const apiKey = JSON.stringify({
			token: credential.accessToken,
			refreshToken: credential.refreshToken,
			expiresAt: credential.expiresAt,
			email: credential.email,
			accountId: credential.accountId,
		});
		directory = await fs.mkdtemp(path.join(os.tmpdir(), CAPTURE_PREFIX));
		await fs.chmod(directory, 0o700);
		await stageAgyCredentials(apiKey, directory);
		const result = await ptree.exec([binary, "--app_data_dir=antigravity-cli", "-p", "/usage"], {
			cwd: directory,
			env: {
				...Bun.env,
				...agyCredentialEnv(),
				AGY_CLI_DISABLE_AUTO_UPDATE: "1",
				GEMINI_HOME: directory,
			},
			timeout: COMMAND_TIMEOUT_MS,
			allowNonZero: true,
			allowAbort: true,
			...(params.signal ? { signal: params.signal } : {}),
		});
		if (!result.ok || result.exitError?.aborted) {
			ctx.logger?.warn("Antigravity CLI usage probe failed", { exitCode: result.exitCode });
			return null;
		}
		const rows = parseAgyUsage(result.stdout);
		if (rows.length === 0) {
			ctx.logger?.warn("Antigravity CLI usage probe returned no quota rows");
			return null;
		}
		return buildReport(params, rows);
	} catch (error) {
		ctx.logger?.warn("Antigravity CLI usage probe failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	} finally {
		if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
	}
}

export const antigravityCliUsageProvider: UsageProvider = {
	id: PROVIDER,
	cacheVersion: 1,
	fetchUsage: fetchAgyUsage,
	supports: params =>
		params.provider === PROVIDER &&
		params.credential.type === "oauth" &&
		!!params.credential.accessToken &&
		!!params.credential.refreshToken &&
		params.credential.expiresAt !== undefined,
};
