import { describe, expect, test } from "bun:test";
import { newChatId } from "../src/shell/ids";

describe("newChatId", () => {
	test("two chats in the same folder are two chats", () => {
		// The regression: the id used to be `new:<counter>:<cwd>` with a counter
		// that reset on reload, while the sidecar pool lives in Rust and does not.
		// Same folder after a reload meant the same label, so `agent_start`
		// re-attached the new tab to the old chat's process.
		const ids = new Set(Array.from({ length: 200 }, () => newChatId()));
		expect(ids.size).toBe(200);
	});

	test("derived from nothing the webview owns", () => {
		// No cwd, no counter, no mount-scoped state — the properties that made the
		// old scheme collide across a reload.
		const id = newChatId();
		expect(id.startsWith("new:")).toBe(true);
		expect(id).not.toContain("/");
		expect(id.slice(4)).toMatch(/^[0-9a-f-]{36}$/);
	});
});
