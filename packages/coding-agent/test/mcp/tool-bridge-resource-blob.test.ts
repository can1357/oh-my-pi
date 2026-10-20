/**
 * An MCP tool result may embed a binary resource
 * (`{type: "resource", resource: {uri, mimeType, blob}}`). The bridge has to
 * surface that payload instead of dropping it, keep exactly one copy of it,
 * and never disclose the absolute local path of a failed save to the model.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { MCPToolDetails } from "@oh-my-pi/pi-tui/tools/mcp";
import type { CustomToolContext, CustomToolResult } from "../../src/extensibility/custom-tools/types";
import { InternalUrlRouter } from "../../src/internal-urls/router";
import { MCPTool } from "../../src/mcp/tool-bridge";
import type { MCPServerConnection, MCPToolCallResult } from "../../src/mcp/types";

type MCPContent = MCPToolCallResult["content"];

/** Run one MCP tool call whose result carries `content`. */
async function callWithContent(
	content: MCPContent,
	context: CustomToolContext,
): Promise<CustomToolResult<MCPToolDetails>> {
	const result: MCPToolCallResult = { content };
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

/** A session `local://` root pinned to a throwaway directory. */
function localContext(root: string): CustomToolContext {
	return {
		localProtocolOptions: { getArtifactsDir: () => root, getSessionId: () => "session-1" },
	} as CustomToolContext;
}

/** Concatenated text of a tool result. */
function textOf(result: CustomToolResult<MCPToolDetails>): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

describe("MCP bridge embedded resource blobs (#14598)", () => {
	it("delivers a supported image blob as an image block and keeps one copy", async () => {
		const result = await callWithContent(
			[
				{
					type: "resource",
					resource: { uri: "example://image/1", mimeType: "IMAGE/PNG; charset=binary", blob: "iVBORw0KGgo=" },
				},
			],
			{} as CustomToolContext,
		);
		expect(result.content).toEqual([
			{ type: "text", text: "[Resource: example://image/1]" },
			{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
		]);
		// The payload now lives in the image block; the details keep provenance only.
		expect(result.details?.rawContent).toEqual([
			{ type: "resource", resource: { uri: "example://image/1", mimeType: "IMAGE/PNG; charset=binary" } },
		]);
	});

	it("saves a non-image blob under local:// with its exact bytes", async () => {
		using temp = TempDir.createSync("@mcp-resource-blob-");
		const audio = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0xff]);
		const result = await callWithContent(
			[
				{
					type: "resource",
					resource: { uri: "waplugin://media/42", mimeType: "audio/ogg", blob: audio.toBase64() },
				},
			],
			localContext(temp.path()),
		);

		const text = textOf(result);
		const url = /local:\/\/mcp-resource-[0-9a-f]+\.ogg/.exec(text)?.[0];
		expect(url).toBeDefined();
		expect(text).toBe(`[Resource: waplugin://media/42]\naudio/ogg payload (7B) saved to ${url}`);
		const filePath = await InternalUrlRouter.instance().locate(url!, {
			localProtocolOptions: localContext(temp.path()).localProtocolOptions,
		});
		expect(new Uint8Array(await Bun.file(filePath!).arrayBuffer())).toEqual(audio);
		expect(result.details?.rawContent).toEqual([
			{ type: "resource", resource: { uri: "waplugin://media/42", mimeType: "audio/ogg" } },
		]);
	});

	it("keeps a zero-byte blob reachable instead of dropping it", async () => {
		using temp = TempDir.createSync("@mcp-resource-blob-");
		const result = await callWithContent(
			[{ type: "resource", resource: { uri: "example://image/empty", mimeType: "image/png", blob: "" } }],
			localContext(temp.path()),
		);

		// A zero-byte payload is not an image block; it is saved as an empty file.
		expect(result.content).toHaveLength(1);
		const text = textOf(result);
		const url = /local:\/\/mcp-resource-[0-9a-f]+\.png/.exec(text)?.[0];
		expect(url).toBeDefined();
		expect(text).toBe(`[Resource: example://image/empty]\nimage/png payload (0B) saved to ${url}`);
		const filePath = await InternalUrlRouter.instance().locate(url!, {
			localProtocolOptions: localContext(temp.path()).localProtocolOptions,
		});
		expect((await fs.stat(filePath!)).size).toBe(0);
		expect(result.details?.rawContent).toEqual([
			{ type: "resource", resource: { uri: "example://image/empty", mimeType: "image/png" } },
		]);
	});

	it("reports an invalid base64 blob instead of dropping it silently", async () => {
		using temp = TempDir.createSync("@mcp-resource-blob-");
		const result = await callWithContent(
			[{ type: "resource", resource: { uri: "example://doc/1", mimeType: "application/pdf", blob: "not*base64!" } }],
			localContext(temp.path()),
		);
		expect(textOf(result)).toBe("[Resource: example://doc/1]\napplication/pdf payload dropped: invalid base64 blob.");
		// Not delivered, so the only copy stays in the raw details.
		expect(result.details?.rawContent).toEqual([
			{ type: "resource", resource: { uri: "example://doc/1", mimeType: "application/pdf", blob: "not*base64!" } },
		]);
	});

	it("keeps the absolute local path out of a failed save's reason", async () => {
		using temp = TempDir.createSync("@mcp-resource-blob-");
		// The artifacts dir is unreachable through a file, so the save fails with
		// a filesystem error that names the absolute path.
		const blocker = path.join(temp.path(), "blocker");
		await Bun.write(blocker, "not a directory");
		const context = localContext(path.join(blocker, "artifacts"));

		const result = await callWithContent(
			[{ type: "resource", resource: { uri: "example://audio/1", mimeType: "audio/ogg", blob: "U01PS0U=" } }],
			context,
		);
		const text = textOf(result);
		expect(text).toContain("could not be saved:");
		expect(text).not.toContain(blocker);
		expect(text).not.toContain(temp.path());
		expect(text).toContain("[path]");
	});

	it("still renders a text resource as text", async () => {
		const result = await callWithContent(
			[{ type: "resource", resource: { uri: "example://text/1", mimeType: "text/plain", text: "hello" } }],
			{} as CustomToolContext,
		);
		expect(result.content).toEqual([{ type: "text", text: "[Resource: example://text/1]\nhello" }]);
		expect(result.details?.rawContent).toEqual([
			{ type: "resource", resource: { uri: "example://text/1", mimeType: "text/plain", text: "hello" } },
		]);
	});
});
