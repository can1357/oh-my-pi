import { describe, expect, test } from "bun:test";
import { commands, isSubcommand, resolveCliArgv } from "@pk-nerdsaver-ai/pi-coding-agent/cli-commands";

describe("runtime command registration", () => {
	test("runtime is a top-level subcommand", () => {
		expect(commands.some(c => c.name === "runtime")).toBe(true);
		expect(isSubcommand("runtime")).toBe(true);
		expect(resolveCliArgv(["runtime", "list"])).toEqual({ argv: ["runtime", "list"] });
	});

	test("runtime lazy loader resolves its command class", async () => {
		const entry = commands.find(command => command.name === "runtime");
		expect(entry).toBeDefined();
		const Runtime = await entry!.load();
		expect(typeof Runtime).toBe("function");
		expect(Runtime.description).toContain("durable operational store");
	});

	test("gateway and operational APIs resolve through published entry points and the root barrel", async () => {
		const [gateway, operational, root] = await Promise.all([
			import("@pk-nerdsaver-ai/pi-coding-agent/gateway"),
			import("@pk-nerdsaver-ai/pi-coding-agent/operational"),
			import("@pk-nerdsaver-ai/pi-coding-agent"),
		]);
		expect(typeof gateway.AgentSessionGateway).toBe("function");
		expect(typeof operational.OperationalStore).toBe("function");
		expect(root.AgentSessionGateway).toBe(gateway.AgentSessionGateway);
		expect(root.OperationalStore).toBe(operational.OperationalStore);
	});
});
