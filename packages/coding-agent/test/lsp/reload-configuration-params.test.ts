// Regression coverage for issue #8383: `lsp reload` must re-send the configured
// settings instead of an empty object.
import { describe, expect, test } from "bun:test";
import { reloadConfigurationParams } from "@oh-my-pi/pi-coding-agent/lsp/servers";
import type { ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";

const BASE_CONFIG: ServerConfig = {
	command: "typescript-language-server",
	args: ["--stdio"],
	fileTypes: [".ts"],
	rootMarkers: ["package.json"],
};

describe("reloadConfigurationParams", () => {
	test("echoes the configured settings so a reload re-applies them", () => {
		const settings: Record<string, unknown> = { typescript: { format: { semicolons: "insert" } } };
		const config: ServerConfig = { ...BASE_CONFIG, settings };
		expect(reloadConfigurationParams(config)).toEqual({ settings });
	});

	test("falls back to an empty object when no settings are configured", () => {
		expect(reloadConfigurationParams(BASE_CONFIG)).toEqual({ settings: {} });
	});

	test("never replaces configured settings with an empty object (issue #8383)", () => {
		const settings: Record<string, unknown> = { biome: { enabled: true } };
		const config: ServerConfig = { ...BASE_CONFIG, settings };
		expect(reloadConfigurationParams(config).settings).toBe(settings);
	});
});
