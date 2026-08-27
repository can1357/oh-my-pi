import { afterEach, describe, expect, it, vi } from "bun:test";
import type { DashboardStats } from "@oh-my-pi/omp-stats";
import * as ompStats from "@oh-my-pi/omp-stats";
import * as statsCli from "../src/cli/stats-cli";
import Stats from "../src/commands/stats";
import * as theme from "../src/modes/theme/theme";
import { parseStatsDashboardArgs } from "../src/slash-commands/helpers/stats-dashboard";

const TEST_CONFIG = { bin: "omp", version: "0.0.0-test", commands: new Map() };

afterEach(() => {
	vi.restoreAllMocks();
});

describe("stats dashboard host arguments", () => {
	it("forwards the real omp stats flags to the dashboard runner", async () => {
		vi.spyOn(theme, "initTheme").mockResolvedValue();
		const runStatsCommand = vi.spyOn(statsCli, "runStatsCommand").mockResolvedValue();
		const command = new Stats(["--host", "::", "--port", "3850"], TEST_CONFIG);

		await command.run();

		expect(runStatsCommand).toHaveBeenCalledWith({
			port: 3850,
			host: "::",
			json: false,
			summary: false,
			range: "24h",
		});
	});

	it("passes the selected --range through to the stats query", async () => {
		vi.spyOn(theme, "initTheme").mockResolvedValue();
		vi.spyOn(ompStats, "syncAllSessions").mockResolvedValue({ processed: 0, files: 0 });
		vi.spyOn(ompStats, "getTotalMessageCount").mockResolvedValue(0);
		const getDashboardStats = vi
			.spyOn(ompStats, "getDashboardStats")
			.mockResolvedValue({} as unknown as DashboardStats);

		const command = new Stats(["--range", "30d", "--json"], TEST_CONFIG);
		await command.run();

		expect(getDashboardStats).toHaveBeenCalledWith("30d");
	});

	it("keeps the slash command loopback-only unless a host is requested", () => {
		expect(parseStatsDashboardArgs("")).toEqual({ port: 3847, host: "127.0.0.1" });
		expect(parseStatsDashboardArgs("--host 0.0.0.0")).toEqual({ port: 3847, host: "0.0.0.0" });
	});
});
