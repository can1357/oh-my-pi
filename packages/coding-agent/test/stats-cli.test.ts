import { afterEach, describe, expect, it, vi } from "bun:test";
import * as statsCli from "../src/cli/stats-cli";
import Stats from "../src/commands/stats";
import * as theme from "@oh-my-pi/pi-tui/theme";
import { parseStatsDashboardArgs } from "../src/slash-commands/helpers/stats-dashboard";

const TEST_CONFIG = { bin: "omp", version: "0.0.0-test", commands: new Map() };

afterEach(() => {
	vi.restoreAllMocks();
});

describe("stats dashboard host arguments", () => {
	it("forwards the real omp stats flags to the dashboard runner", async () => {
		vi.spyOn(theme, "initTheme").mockResolvedValue();
		const runStatsCommand = vi.spyOn(statsCli, "runStatsCommand").mockResolvedValue();
		const command = new Stats(
			["--host", "::", "--port", "3850", "--allowed-host", "a.ts.net", "--allowed-host", "*.example.net"],
			TEST_CONFIG,
		);

		await command.run();

		expect(runStatsCommand).toHaveBeenCalledWith({
			port: 3850,
			host: "::",
			allowedHosts: ["a.ts.net", "*.example.net"],
			json: false,
			summary: false,
		});
	});

	it("keeps the slash command loopback-only unless a host is requested", () => {
		expect(parseStatsDashboardArgs("")).toEqual({ port: 3847, host: "127.0.0.1", allowedHosts: [] });
		expect(parseStatsDashboardArgs("--host 0.0.0.0")).toEqual({ port: 3847, host: "0.0.0.0", allowedHosts: [] });
	});

	it("collects repeated --allowed-host names for a LAN or Tailscale bind", () => {
		expect(
			parseStatsDashboardArgs("--host 0.0.0.0 --allowed-host box.example.ts.net --allowed-host=*.lan.example"),
		).toEqual({ port: 3847, host: "0.0.0.0", allowedHosts: ["box.example.ts.net", "*.lan.example"] });
		expect(parseStatsDashboardArgs("--allowed-host")).toEqual({
			error: expect.stringContaining("Missing allowed host"),
		});
	});
});
