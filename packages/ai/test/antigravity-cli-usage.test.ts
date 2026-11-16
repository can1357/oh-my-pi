import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { quotaTierFor } from "@oh-my-pi/pi-catalog/compat/behavior";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { UsageFetchContext, UsageFetchParams, UsageReport } from "../src/usage";
import { antigravityCliUsageProvider, fetchAgyUsage, parseAgyUsage } from "../src/usage/antigravity-cli";
import { defaultRankingStrategy } from "../src/usage/registry";

const OUTPUT = [
	"Gemini Models\tWeekly Limit Remaining\t72%\t2026-11-20T22:56:51Z",
	"Gemini Models\tFive Hour Limit Remaining\t97%\t2026-11-15T22:39:07Z",
	"Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-16T05:58:33Z",
	"Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-11-16T00:02:09Z",
	"Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t12%\t2026-11-21T03:04:50Z",
].join("\n");

const credential = {
	type: "oauth" as const,
	accessToken: "fixture-access",
	refreshToken: "fixture-refresh",
	expiresAt: Date.now() + 3_600_000,
	email: "account@example.test",
	accountId: "fixture-account",
};

const params: UsageFetchParams = { provider: "antigravity-cli", credential };
const context: UsageFetchContext = {
	fetch: async () => {
		throw new Error("network disabled");
	},
};

describe("parseAgyUsage", () => {
	it("parses the CLI quota table", () => {
		const rows = parseAgyUsage(OUTPUT);
		expect(rows).toHaveLength(5);
		expect(rows[0]).toEqual({
			group: "Gemini Models",
			window: "Weekly Limit Remaining",
			remainingFraction: 0.72,
			resetsAt: Date.parse("2026-11-20T22:56:51Z"),
		});
		expect(rows[4]).toEqual({
			group: "Gemini 4 Argon",
			window: "Gemini 4 Argon Weekly Limit",
			remainingFraction: 0.12,
			resetsAt: Date.parse("2026-11-21T03:04:50Z"),
		});
	});

	it("ignores malformed rows and empty output", () => {
		expect(parseAgyUsage("")).toEqual([]);
		expect(parseAgyUsage("Gemini\tWeekly\tnot-a-percent\t")).toEqual([]);
		expect(parseAgyUsage("Gemini\tWeekly\t101%\t")).toEqual([]);
		expect(parseAgyUsage("Gemini\tWeekly\t-1%\t")).toEqual([]);
	});
});

describe("antigravityCliUsageProvider", () => {
	it("supports OAuth credentials with a refresh token", () => {
		expect(antigravityCliUsageProvider.supports?.(params)).toBe(true);
		expect(
			antigravityCliUsageProvider.supports?.({
				...params,
				credential: { ...credential, type: "api_key" },
			}),
		).toBe(false);
		expect(
			antigravityCliUsageProvider.supports?.({
				...params,
				credential: { ...credential, refreshToken: undefined },
			}),
		).toBe(false);
	});

	it("scopes limits to the model's quota bucket", () => {
		expect(quotaTierFor("antigravity-cli", "gemini-4-carbon")).toBe("gemini");
		expect(quotaTierFor("antigravity-cli", "gemini-4-argon")).toBe("gemini-argon");
		expect(quotaTierFor("antigravity-cli", "claude-sonnet-5-5")).toBe("claude-gpt");
		const report: UsageReport = {
			provider: "antigravity-cli",
			fetchedAt: 0,
			limits: [
				{
					id: "antigravity-cli:gemini:weekly",
					label: "Gemini Models",
					scope: { provider: "antigravity-cli" },
					amount: { unit: "percent", remainingFraction: 0.8 },
					status: "ok",
				},
				{
					id: "antigravity-cli:gemini-argon:weekly",
					label: "Gemini 4 Argon",
					scope: { provider: "antigravity-cli" },
					amount: { unit: "percent", remainingFraction: 0 },
					status: "exhausted",
				},
				{
					id: "antigravity-cli:claude-gpt:weekly",
					label: "Claude and GPT models",
					scope: { provider: "antigravity-cli" },
					amount: { unit: "percent", remainingFraction: 1 },
					status: "ok",
				},
			],
		};
		const strategy = defaultRankingStrategy("antigravity-cli");
		expect(strategy).toBeDefined();
		const scoped = (modelId: string) => strategy!.scopeLimits!(report, { modelId }).map(limit => limit.id);
		expect(scoped("gemini-4-carbon")).toEqual(["antigravity-cli:gemini:weekly"]);
		expect(scoped("gemini-4-argon")).toEqual(["antigravity-cli:gemini-argon:weekly"]);
		expect(scoped("claude-sonnet-5-5")).toEqual(["antigravity-cli:claude-gpt:weekly"]);
	});

	it.skipIf(process.platform === "win32")(
		"runs the official CLI with a private staged credential and maps the quota",
		async () => {
			using temp = TempDir.createSync("@omp-agy-usage-");
			const cli = temp.join("agy");
			const capture = temp.join("capture.txt");
			const quota = temp.join("quota.txt");
			await Bun.write(quota, OUTPUT);
			await Bun.write(
				cli,
				`#!/bin/sh
app_data=""
for arg in "$@"; do
	case "$arg" in
		--app_data_dir=*) app_data="\${arg#--app_data_dir=}" ;;
	esac
done
printf 'SSH_TTY=%s\\n' "$SSH_TTY" > "$CAPTURE"
printf 'AUTO_UPDATE=%s\\n' "$AGY_CLI_DISABLE_AUTO_UPDATE" >> "$CAPTURE"
if [ -f "$app_data/antigravity-oauth-token" ]; then printf 'TOKEN=yes\\n' >> "$CAPTURE"; else printf 'TOKEN=no\\n' >> "$CAPTURE"; fi
printf 'APP_DATA=%s\\n' "$app_data" >> "$CAPTURE"
cat "$QUOTA_OUTPUT"
`,
			);
			await fs.chmod(cli, 0o755);
			const previous = {
				PI_AGY_PATH: process.env.PI_AGY_PATH,
				CAPTURE: process.env.CAPTURE,
				QUOTA_OUTPUT: process.env.QUOTA_OUTPUT,
			};
			process.env.PI_AGY_PATH = cli;
			process.env.CAPTURE = capture;
			process.env.QUOTA_OUTPUT = quota;
			try {
				const report = await fetchAgyUsage(params, context);
				expect(report).not.toBeNull();
				expect(report?.provider).toBe("antigravity-cli");
				expect(report?.limits).toHaveLength(5);
				expect(report?.metadata).toMatchObject({
					endpoint: "agy /usage",
					email: credential.email,
					accountId: credential.accountId,
				});
				const argon = report?.limits.find(limit => limit.id === "antigravity-cli:gemini-argon:weekly");
				expect(argon).toMatchObject({
					label: "Gemini 4 Argon",
					window: {
						id: "weekly",
						label: "Weekly",
						resetsAt: Date.parse("2026-11-21T03:04:50Z"),
					},
					status: "ok",
				});
				expect(argon?.amount.unit).toBe("percent");
				expect(argon?.amount.remainingFraction).toBeCloseTo(0.12);
				expect(argon?.amount.usedFraction).toBeCloseTo(0.88);
				const lines = (await Bun.file(capture).text()).trim().split("\n");
				expect(lines).toContain("SSH_TTY=omp-agy-file-auth");
				expect(lines).toContain("AUTO_UPDATE=1");
				expect(lines).toContain("TOKEN=yes");
				const appData = lines.find(line => line.startsWith("APP_DATA="))?.slice("APP_DATA=".length);
				expect(appData).toContain("omp-agy-usage-");
				await expect(fs.access(path.dirname(appData!))).rejects.toThrow();
			} finally {
				for (const [key, value] of Object.entries(previous)) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
			}
		},
	);
});
