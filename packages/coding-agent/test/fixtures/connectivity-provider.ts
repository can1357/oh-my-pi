import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { type } from "@oh-my-pi/omptype";

export default function registerConnectivityFixture(pi: ExtensionAPI): void {
	const baseUrl = process.env.OMP_CONNECTIVITY_TEST_URL;
	if (!baseUrl?.startsWith("http://127.0.0.1:")) throw new Error("Expected a loopback-only test provider");
	pi.registerTool({
		name: "connectivity_record",
		label: "Record",
		description: "Record a test side effect",
		parameters: type({}),
		execute: async () => {
			const ledger = process.env.OMP_CONNECTIVITY_TEST_LEDGER;
			if (!ledger) throw new Error("Expected a test ledger");
			const previous = (await Bun.file(ledger).exists()) ? await Bun.file(ledger).text() : "";
			await Bun.write(ledger, `${previous}recorded once\n`);
			return { content: [{ type: "text", text: "recorded once" }], details: {} };
		},
	});
	pi.registerProvider("connectivity-fixture", {
		baseUrl,
		apiKey: "literal-test-key",
		api: "openai-completions",
		models: [
			{
				id: "connection-test",
				name: "Connection Test",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 4096,
			},
		],
	});
}
