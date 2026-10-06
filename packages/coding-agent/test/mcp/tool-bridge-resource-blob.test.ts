import * as fs from "node:fs/promises";
import { describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { MCPToolDetails } from "@oh-my-pi/pi-tui/tools/mcp";
import type { CustomToolContext, CustomToolResult } from "../../src/extensibility/custom-tools/types";
import { InternalUrlRouter } from "../../src/internal-urls/router";
import { MCPTool } from "../../src/mcp/tool-bridge";
import type { MCPServerConnection, MCPToolCallResult } from "../../src/mcp/types";

async function callWithResource(
	resource: { uri: string; mimeType?: string; blob: string },
	context: CustomToolContext,
): Promise<CustomToolResult<MCPToolDetails>> {
	const result: MCPToolCallResult = { content: [{ type: "resource", resource }] };
	const connection = {
		name: "media",
		transport: {
			request: async (method: string) => {
				if (method === "tools/call") return result;
				throw new Error(`unexpected method ${method}`);
			},
			close: async () => {},
		},
	} as unknown as MCPServerConnection;
	const tool = new MCPTool(connection, { name: "get_media", inputSchema: { type: "object" } });
	return tool.execute("call-1", {}, undefined, context);
}

describe("MCP bridge embedded resource blobs (#14598)", () => {
	it("delivers a supported image blob to the model as an image block", async () => {
		const result = await callWithResource(
			{ uri: "example://image/1", mimeType: "IMAGE/PNG; charset=binary", blob: "iVBORw0KGgo=" },
			{} as CustomToolContext,
		);
		expect(result.content).toEqual([
			{ type: "text", text: "[Resource: example://image/1]" },
			{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
		]);
	});

	it("saves a non-image blob under local:// with its decoded bytes and reports MIME and size", async () => {
		using temp = TempDir.createSync("@mcp-resource-blob-");
		const localProtocolOptions = { getArtifactsDir: () => temp.path(), getSessionId: () => "session-1" };
		const audio = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0xff]);
		const result = await callWithResource(
			{ uri: "waplugin://media/42", mimeType: "audio/ogg", blob: audio.toBase64() },
			{ localProtocolOptions } as CustomToolContext,
		);

		const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
		const url = /local:\/\/mcp-resource-[0-9a-f]+\.ogg/.exec(text)?.[0];
		expect(url).toBeDefined();
		expect(text).toBe(`[Resource: waplugin://media/42]\naudio/ogg payload (7B) saved to ${url}`);
		const filePath = await InternalUrlRouter.instance().locate(url!, { localProtocolOptions });
		expect(new Uint8Array(await Bun.file(filePath!).arrayBuffer())).toEqual(audio);
	});

	it("saves a zero-byte blob as an empty file instead of an empty image block", async () => {
		using temp = TempDir.createSync("@mcp-resource-blob-");
		const localProtocolOptions = { getArtifactsDir: () => temp.path(), getSessionId: () => "session-1" };
		const result = await callWithResource({ uri: "example://image/empty", mimeType: "image/png", blob: "" }, {
			localProtocolOptions,
		} as CustomToolContext);

		expect(result.content).toHaveLength(1);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		const url = /local:\/\/mcp-resource-[0-9a-f]+\.png/.exec(text)?.[0];
		expect(text).toBe(`[Resource: example://image/empty]\nimage/png payload (0B) saved to ${url}`);
		const filePath = await InternalUrlRouter.instance().locate(url!, { localProtocolOptions });
		expect((await fs.stat(filePath!)).size).toBe(0);
	});

	it("reports an invalid base64 blob instead of saving garbage", async () => {
		using temp = TempDir.createSync("@mcp-resource-blob-");
		const localProtocolOptions = { getArtifactsDir: () => temp.path(), getSessionId: () => "session-1" };
		const result = await callWithResource(
			{ uri: "example://doc/1", mimeType: "application/pdf", blob: "not*base64!" },
			{ localProtocolOptions } as CustomToolContext,
		);
		expect(result.content).toEqual([
			{ type: "text", text: "[Resource: example://doc/1]\napplication/pdf payload dropped: invalid base64 blob." },
		]);
	});
});
