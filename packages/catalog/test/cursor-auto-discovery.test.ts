import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { fetchCursorUsableModels } from "../src/discovery/cursor";
import { buildModel } from "../src/build";
import { collapseBuiltVariants } from "../src/compat/collapse";
import { GetUsableModelsResponseSchema, ModelDetailsSchema } from "../src/discovery/cursor-proto";
import { create, toBinary } from "../src/discovery/protobuf";
import type { ModelSpec } from "../src/types";

let server: http2.Http2Server;
let baseUrl: string;

beforeAll(async () => {
	const response = create(GetUsableModelsResponseSchema, {
		models: [
			create(ModelDetailsSchema, { modelId: "auto", displayName: "auto" }),
			create(ModelDetailsSchema, { modelId: "composer-2.5" }),
			create(ModelDetailsSchema, { modelId: "novel-low" }),
			create(ModelDetailsSchema, { modelId: "novel-high" }),
		],
	});
	const payload = Buffer.from(toBinary(GetUsableModelsResponseSchema, response));

	server = http2.createServer();
	server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		stream.on("data", () => {});
		stream.on("end", () => {
			if (headers[":path"] !== "/agent.v1.AgentService/GetUsableModels") {
				stream.respond({ ":status": 404 });
				stream.end();
				return;
			}
			stream.respond({ ":status": 200, "content-type": "application/proto" });
			stream.end(payload);
		});
	});
	const { promise, resolve } = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", resolve);
	await promise;
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("expected http2 fixture server to bind a tcp port");
	}
	baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
	server?.close();
});

async function discover(): Promise<Map<string, ModelSpec<"cursor-agent">>> {
	const models = await fetchCursorUsableModels({ apiKey: "test-key", baseUrl });
	expect(models).not.toBeNull();
	return new Map((models ?? []).map(model => [model.id, model]));
}

describe("cursor discovery auto sentinel", () => {
	it("records the verbatim roster id on the auto entry for wire echo", async () => {
		const byId = await discover();
		expect(byId.get("auto")?.requestModelId).toBe("auto");
	});

	it("preserves concrete roster wire identity without a model-specific mapper exception", async () => {
		const byId = await discover();
		expect(byId.get("composer-2.5")?.requestModelId).toBe("composer-2.5");
	});

	it("same-ID roster identity does not disable dynamic effort-family collapsing", async () => {
		const byId = await discover();
		const members = [byId.get("novel-low")!, byId.get("novel-high")!].map(buildModel);
		const collapsed = collapseBuiltVariants(members);
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0]?.id).toBe("novel");
		expect(collapsed[0]?.thinking?.effortRouting).toEqual({ low: "novel-low", high: "novel-high" });
	});
});
