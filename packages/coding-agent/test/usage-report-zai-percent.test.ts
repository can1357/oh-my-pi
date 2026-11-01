import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { zaiUsageProvider } from "@oh-my-pi/pi-ai/usage/zai";
import { buildUsageReportText } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/usage-report";

describe("/usage with Z.AI credit quotas", () => {
	it("prints a percentage-only credit meter as a percentage, not as credits", async () => {
		const fetch: FetchImpl = async input => {
			const body = String(input).includes("/api/monitor/usage/model-usage")
				? { success: true, data: {} }
				: { success: true, data: { limits: [{ type: "CREDIT_LIMIT", percentage: 42, unit: 3, number: 5 }] } };
			return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
		};
		const report = await zaiUsageProvider.fetchUsage!(
			{ provider: "zai", credential: { type: "api_key", apiKey: "zai-test-key" }, signal: undefined },
			{ fetch },
		);

		const text = await buildUsageReportText({
			session: { model: undefined, fetchUsageReports: async () => [report!] },
		} as never);

		expect(text).toContain("42.00% used");
		expect(text).not.toContain("credits used");
	});
});
