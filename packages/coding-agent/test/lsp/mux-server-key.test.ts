import { describe, expect, it } from "bun:test";
import { type MuxConnectParams, muxServerKey } from "@oh-my-pi/pi-coding-agent/lsp/mux/protocol";

const base: MuxConnectParams = {
	command: "typescript-language-server",
	args: ["--stdio"],
	cwd: "/workspace/project",
};

describe("muxServerKey", () => {
	it("is stable across equal-by-value handshake parameters", () => {
		expect(muxServerKey({ ...base })).toBe(muxServerKey({ ...base, args: [...base.args] }));
	});

	it("still separates servers by command and by cwd", () => {
		expect(muxServerKey({ ...base, command: "rust-analyzer" })).not.toBe(muxServerKey(base));
		expect(muxServerKey({ ...base, cwd: "/workspace/other" })).not.toBe(muxServerKey(base));
	});

	it("separates servers that differ only in args", () => {
		// The registry reuses an idle server purely by key, so an args-only
		// difference must not collide — a server started with extra flags is a
		// different process than one started without them.
		const verbose = muxServerKey({ ...base, args: ["--stdio", "--log-level", "4"] });
		expect(verbose).not.toBe(muxServerKey(base));
	});

	it("keeps split and joined arguments distinct", () => {
		const split = muxServerKey({ ...base, args: ["--log-level", "4"] });
		const joined = muxServerKey({ ...base, args: ["--log-level 4"] });
		expect(split).not.toBe(joined);
	});

	it("separates servers that differ only in env", () => {
		const tuned = muxServerKey({ ...base, env: { NODE_OPTIONS: "--max-old-space-size=8192" } });
		expect(tuned).not.toBe(muxServerKey(base));
	});
	it("does not expose environment values in the externally visible key", () => {
		const secret = "secret-language-server-token";
		expect(muxServerKey({ ...base, env: { LANGUAGE_SERVER_TOKEN: secret } })).not.toContain(secret);
	});

	it("treats env key order as irrelevant", () => {
		const forward = muxServerKey({ ...base, env: { A: "1", B: "2" } });
		const reverse = muxServerKey({ ...base, env: { B: "2", A: "1" } });
		expect(forward).toBe(reverse);
	});

	it("treats an absent env as an empty env", () => {
		expect(muxServerKey({ ...base, env: {} })).toBe(muxServerKey(base));
	});
});
