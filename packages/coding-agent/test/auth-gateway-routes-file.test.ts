import { describe, expect, test } from "bun:test";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAuthGatewayRoutesPath } from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-cli";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SETTINGS_SCHEMA } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("resolveAuthGatewayRoutesPath", () => {
	test("flag path wins over config", () => {
		expect(resolveAuthGatewayRoutesPath("/flag.json5", "/config.json5")).toBe("/flag.json5");
	});

	test("flag absent uses config path", () => {
		expect(resolveAuthGatewayRoutesPath(undefined, "/config.json5")).toBe("/config.json5");
	});

	test("neither yields undefined", () => {
		expect(resolveAuthGatewayRoutesPath(undefined, undefined)).toBeUndefined();
	});

	test("trims whitespace on the winning path", () => {
		expect(resolveAuthGatewayRoutesPath("  /flag.json5  ", "/config.json5")).toBe("/flag.json5");
		expect(resolveAuthGatewayRoutesPath(undefined, "  /config.json5  ")).toBe("/config.json5");
	});

	test("empty flag throws like empty --routes", () => {
		expect(() => resolveAuthGatewayRoutesPath("", "/config.json5")).toThrow(
			"`omp auth-gateway serve --routes` requires a file path",
		);
		expect(() => resolveAuthGatewayRoutesPath("   ", "/config.json5")).toThrow(
			"`omp auth-gateway serve --routes` requires a file path",
		);
	});

	test("empty config path throws like empty --routes", () => {
		expect(() => resolveAuthGatewayRoutesPath(undefined, "")).toThrow(
			"`auth.gateway.routesFile` requires a file path",
		);
		expect(() => resolveAuthGatewayRoutesPath(undefined, "   ")).toThrow(
			"`auth.gateway.routesFile` requires a file path",
		);
	});
});

describe("auth.gateway.routesFile setting", () => {
	test("is an optional hidden string in the schema", () => {
		const def = SETTINGS_SCHEMA["auth.gateway.routesFile"];
		expect(def).toEqual({ type: "string", default: undefined });
		expect("ui" in def).toBe(false);
	});

	test("loadReadOnly reads nested config.yml", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-routes-file-"));
		try {
			await Bun.write(
				path.join(agentDir, "config.yml"),
				"auth:\n  gateway:\n    routesFile: /tmp/from-config.json5\n",
			);
			const loaded = await Settings.loadReadOnly({ agentDir, cwd: agentDir });
			expect(loaded.get("auth.gateway.routesFile")).toBe("/tmp/from-config.json5");
		} finally {
			resetSettingsForTest();
			await removeWithRetries(agentDir);
		}
	});

	test("loadReadOnly leaves routesFile unset when omitted", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-routes-file-empty-"));
		try {
			await Bun.write(path.join(agentDir, "config.yml"), "setupVersion: 0\n");
			const loaded = await Settings.loadReadOnly({ agentDir, cwd: agentDir });
			expect(loaded.get("auth.gateway.routesFile")).toBeUndefined();
		} finally {
			resetSettingsForTest();
			await removeWithRetries(agentDir);
		}
	});
});
