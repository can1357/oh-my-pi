import { expect, test } from "bun:test";
import { cloudflareAiGatewayModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { serializeCloudflareCredential } from "@oh-my-pi/pi-catalog/wire/cloudflare";
import { getBundledModels } from "../src/models";
import { toModelSpec } from "../src/provider-models/bundled-references";

test("requests the Cloudflare task name on every model search page", async () => {
	const references = getBundledModels("cloudflare-ai-gateway").filter(
		model => model.id.startsWith("workers-ai/") && model.api === "openai-completions",
	).slice(0, 2);
	if (references.length < 2) throw new Error("Expected two bundled Workers AI gateway chat models");
	const requests: URL[] = [];
	const fetchMock = (async (input: string | URL | Request) => {
		const url = new URL(String(input));
		requests.push(url);
		if (url.searchParams.get("task") !== "Text Generation") {
			return Response.json({ success: true, result: [] });
		}
		const page = url.searchParams.get("page");
		return Response.json({
			success: true,
			result_info: { total_pages: 2 },
			result: [{ name: references[page === "1" ? 0 : 1]!.id.slice("workers-ai/".length), task: { name: "Text Generation" } }],
		});
	}) as typeof fetch;
	const apiKey = serializeCloudflareCredential({ token: "token", accountId: "account", gatewayId: "gateway" });
	const models = await cloudflareAiGatewayModelManagerOptions({ apiKey, fetch: fetchMock }).fetchDynamicModels?.();

	expect(requests.map(url => url.searchParams.get("task"))).toEqual(["Text Generation", "Text Generation"]);
	expect(requests.map(url => url.searchParams.get("page"))).toEqual(["1", "2"]);
	expect(models).toEqual(references.map(model => ({ ...toModelSpec(model), discoveryCostFields: [], discoveryMetadataFields: [] })));
});
