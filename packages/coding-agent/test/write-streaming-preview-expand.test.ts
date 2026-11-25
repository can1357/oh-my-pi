import { describe, expect, it } from "bun:test";
import {
	decodeStreamedToolArgs,
	streamingStringKeysForTool,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/tool-args-reveal";

describe("streamed write args decode", () => {
	it("shows content grown past the last throttled parse when rebuilt mid-stream", () => {
		// Regression: a transcript rebuild (theme change, settings, focus replay)
		// recreates the pending write card while args still stream. The rebuild
		// must decode display args from the raw partialJson buffer — the
		// provider-parsed arguments lag by up to a throttled parse window, and
		// spreading them alone froze the preview at the last full parse.
		const staleContent = "line before throttle";
		// Provider parsed up to here…
		const seenByProvider = `{"path":"/tmp/foo.ts","content":"${staleContent}`;
		// …then the buffer grew, but not enough to re-trigger the 256-byte parse.
		const partialJson = `${seenByProvider}\\nGROWN_TAIL_SENTINEL`;
		const staleProviderArgs = { path: "/tmp/foo.ts", content: staleContent };

		const renderArgs = decodeStreamedToolArgs(partialJson, {
			rawInput: false,
			fullArgs: staleProviderArgs,
			streamingStringKeys: streamingStringKeysForTool("write", false),
		});

		expect(renderArgs.path).toBe("/tmp/foo.ts");
		expect(renderArgs.content).toBe(`${staleContent}\nGROWN_TAIL_SENTINEL`);
		expect(renderArgs.__partialJson).toBe(partialJson);
	});
});
