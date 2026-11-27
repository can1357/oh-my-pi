import { describe, expect, test } from "bun:test";
import { generateRpcArtifacts } from "../../scripts/gen-rpc";

describe("RPC wire artifacts", () => {
	test("committed schema bundle and generated clients match a fresh `bun run gen:rpc`", async () => {
		for (const [file, contents] of generateRpcArtifacts()) {
			expect(await Bun.file(file).text(), file).toBe(contents);
		}
	});
});

test("activity schema closes only the frame, leaving draft field names open", async () => {
	const bundle = await Bun.file(new URL("../../src/modes/rpc/wire/rpc-wire.schema.json", import.meta.url)).json();
	const activity = bundle.$defs.ExtensionUiActivity;
	expect(activity.additionalProperties).toBe(false);
	expect(activity.properties.data.additionalProperties).toEqual({});
	expect(activity.required).toEqual(["type", "id"]);
});
