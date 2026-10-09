import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import * as grokbotCatalogAuth from "@oh-my-pi/pi-catalog/discovery/grokbot-auth";
import { TRUNCATE_LENGTHS } from "@oh-my-pi/pi-tui/render/render-utils";
import { formatGrokbotStatus } from "../src/utils/grokbot-status";

afterEach(() => vi.restoreAllMocks());

describe("Grokbot status redaction and credential precedence", () => {
	test("sanitizes namespace and client version in /grokbot status", async () => {
		spyOn(grokbotCatalogAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew-present",
			machineId: "machine-present",
			namespace: "lab\t\x1b[31mevil\x1b[0m",
			clientVersion: `${"x".repeat(80)}\nnext-line`,
		});
		spyOn(grokbotCatalogAuth, "grokbotSecretsPath").mockReturnValue("/tmp/agent/secrets/grokbot.env");

		const status = await formatGrokbotStatus();
		expect(status).toContain("Namespace: lab   evil");
		expect(status).not.toContain("\x1b");
		expect(status).not.toContain("\t");
		const versionLine = status.split("\n").find(line => line.startsWith("Client version:"));
		expect(versionLine).toBeDefined();
		expect(versionLine!.includes("next-line")).toBe(false);
		expect(Bun.stringWidth(versionLine!.slice("Client version: ".length))).toBeLessThanOrEqual(
			TRUNCATE_LENGTHS.TITLE,
		);
	});

	test("reports renewer present when AuthStorage / models.yml credential is passed", async () => {
		spyOn(grokbotCatalogAuth, "loadGrokbotConfig").mockImplementation(async (renewalOverride?: string) => ({
			renewal: renewalOverride || "",
			machineId: "machine-present",
			namespace: "prod",
			clientVersion: "0.30.0",
		}));
		spyOn(grokbotCatalogAuth, "grokbotSecretsPath").mockReturnValue("/tmp/agent/secrets/grokbot.env");

		const without = await formatGrokbotStatus();
		expect(without).toContain("Renewer: missing");
		const withConfigured = await formatGrokbotStatus({ renewalCredential: "yml-or-runtime-renewal" });
		expect(withConfigured).toContain("Renewer: present");
	});

	test("reports configured proxy baseUrl instead of the hard-coded default host", async () => {
		spyOn(grokbotCatalogAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew-present",
			machineId: "machine-present",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotCatalogAuth, "grokbotSecretsPath").mockReturnValue("/tmp/agent/secrets/grokbot.env");

		const status = await formatGrokbotStatus({ baseUrl: "https://proxy.example/grokbot/" });
		expect(status).toContain("Host: https://proxy.example/grokbot");
		expect(status).not.toContain("Host: https://api2.cursor.sh");
	});

	test("redacts URL userinfo and all query params from Host status", async () => {
		spyOn(grokbotCatalogAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew-present",
			machineId: "machine-present",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotCatalogAuth, "grokbotSecretsPath").mockReturnValue("/tmp/agent/secrets/grokbot.env");

		const status = await formatGrokbotStatus({
			baseUrl: "https://token:sekrit@proxy.example/grokbot?api_key=leak&x-api-key=also&keep=1",
		});
		const hostLine = status.split("\n").find(line => line.startsWith("Host:"));
		expect(hostLine).toBe("Host: https://proxy.example/grokbot");
		expect(hostLine).not.toContain("token");
		expect(hostLine).not.toContain("sekrit");
		expect(hostLine).not.toContain("api_key");
		expect(hostLine).not.toContain("x-api-key");
		expect(hostLine).not.toContain("leak");
		expect(hostLine).not.toContain("keep=1");
	});

	test("redacts URL fragments from Host status", async () => {
		spyOn(grokbotCatalogAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew-present",
			machineId: "machine-present",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotCatalogAuth, "grokbotSecretsPath").mockReturnValue("/tmp/agent/secrets/grokbot.env");

		const status = await formatGrokbotStatus({
			baseUrl: "https://proxy.example/grokbot#token=secret",
		});
		const hostLine = status.split("\n").find(line => line.startsWith("Host:"));
		expect(hostLine).toBe("Host: https://proxy.example/grokbot");
		expect(hostLine).not.toContain("token");
		expect(hostLine).not.toContain("secret");
		expect(hostLine).not.toContain("#");
	});

	test("redacts userinfo and query from malformed Host URLs without a scheme", async () => {
		spyOn(grokbotCatalogAuth, "loadGrokbotConfig").mockResolvedValue({
			renewal: "renew-present",
			machineId: "machine-present",
			namespace: "prod",
			clientVersion: "0.30.0",
		});
		spyOn(grokbotCatalogAuth, "grokbotSecretsPath").mockReturnValue("/tmp/agent/secrets/grokbot.env");

		const status = await formatGrokbotStatus({
			baseUrl: "user:sekrit@proxy.local?x-api-key=leak&keep=1",
		});
		const hostLine = status.split("\n").find(line => line.startsWith("Host:"));
		expect(hostLine).toBe("Host: proxy.local");
		expect(hostLine).not.toContain("sekrit");
		expect(hostLine).not.toContain("x-api-key");
		expect(hostLine).not.toContain("leak");
		expect(hostLine).not.toContain("keep=1");
	});
});
