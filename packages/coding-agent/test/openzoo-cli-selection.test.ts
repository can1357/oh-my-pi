import { expect, spyOn, test } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

for (const args of [
	["--provider", "openzoo", "--model", "auto"],
	["--model", "openzoo/auto"],
]) {
	test(`cold CLI discovery resolves ${args.join(" ")}`, async () => {
		const tmp = await TempDir.create("@openzoo-cli-");
		const authStorage = createInMemoryAuthStorage();
		const settings = Settings.isolated({});
		const urls: string[] = [];
		const registry = new ModelRegistry(authStorage, tmp.join("models.yml"), {
			settings,
			fetch: async input => {
				urls.push(String(input));
				return Response.json({ data: [{ id: "openzoo/auto", owned_by: "openzoo" }] });
			},
		});
		const exit = spyOn(process, "exit").mockImplementation(code => {
			throw new Error(`CLI exited before discovering models: ${code}`);
		});
		try {
			expect(registry.getAvailable().filter(model => model.provider === "openzoo")).toEqual([]);
			const options = await buildSessionOptions(parseArgs(args), [], undefined, registry, settings);
			expect(options.model?.provider).toBe("openzoo");
			expect(options.model?.id).toBe("auto");
			expect(urls).toHaveLength(1);
			expect(urls[0]).toEndWith("/v1/models");
		} finally {
			exit.mockRestore();
			authStorage.close();
			await tmp.remove();
		}
	});
}
