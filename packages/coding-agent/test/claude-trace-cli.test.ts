import { describe, expect, spyOn, test } from "bun:test";
import * as piUtils from "@oh-my-pi/pi-utils";
import { runClaudeMessagesCapture } from "../src/cli/claude-trace-cli";

// Contract: when the `openssl` executable is missing, `omp claude-trace` must
// surface a targeted prerequisite error — naming openssl and its purpose
// (generating the temporary TLS key/certificate for the local trace proxy) —
// instead of the opaque Bun.spawn failure that used to escape from proxy
// startup on Windows/minimal installs.
describe("claude-trace openssl prerequisite", () => {
	test("missing openssl surfaces a targeted prerequisite error before the proxy starts", async () => {
		const which = spyOn(piUtils, "$which").mockReturnValue(null);
		let error: unknown;
		try {
			try {
				await runClaudeMessagesCapture({});
			} catch (caught) {
				error = caught;
			}
		} finally {
			which.mockRestore();
		}
		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toMatch(/openssl/);
		expect(message).toMatch(/TLS key\/certificate/);
	});
});
