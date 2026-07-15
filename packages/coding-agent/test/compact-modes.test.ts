import { describe, expect, it } from "bun:test";
import {
	findCompactMode,
	parseCompactArgs,
	SNAPCOMPACT_RETIREMENT_ERROR,
} from "@pk-nerdsaver-ai/pi-coding-agent/session/compact-modes";

describe("compact mode registry", () => {
	it("maps the supported modes to the settings overrides the engine relies on", () => {
		expect(findCompactMode("soft")?.overrides).toEqual({ strategy: "context-full", remoteEnabled: false });
		expect(findCompactMode("remote")?.overrides).toEqual({ strategy: "context-full", remoteEnabled: true });
		expect(findCompactMode("snapcompact")).toBeUndefined();
	});

	it("flags only remote as remote-requiring", () => {
		expect(findCompactMode("remote")?.requiresRemote).toBe(true);
		expect(findCompactMode("soft")?.requiresRemote).toBeUndefined();
	});

	it("resolves mode names case-insensitively and rejects unknowns", () => {
		expect(findCompactMode("SOFT")?.name).toBe("soft");
		expect(findCompactMode("  Remote ")?.name).toBe("remote");
		expect(findCompactMode("bogus")).toBeUndefined();
		expect(findCompactMode("")).toBeUndefined();
	});
});

describe("parseCompactArgs", () => {
	it("returns no mode and no instructions for empty args", () => {
		expect(parseCompactArgs("")).toEqual({});
		expect(parseCompactArgs("   ")).toEqual({});
	});

	it("detects supported leading mode tokens", () => {
		expect(parseCompactArgs("soft")).toEqual({ mode: "soft" });
		expect(parseCompactArgs("remote")).toEqual({ mode: "remote" });
	});

	it("splits a mode from its trailing focus instructions", () => {
		expect(parseCompactArgs("soft focus on the parser bug")).toEqual({
			mode: "soft",
			instructions: "focus on the parser bug",
		});
		expect(parseCompactArgs("remote   keep auth details")).toEqual({
			mode: "remote",
			instructions: "keep auth details",
		});
	});

	it("treats a non-mode first token as plain focus instructions", () => {
		expect(parseCompactArgs("summarize the auth flow")).toEqual({ instructions: "summarize the auth flow" });
		expect(parseCompactArgs("everything")).toEqual({ instructions: "everything" });
	});

	it("rejects every removed snapcompact invocation with the retirement error", () => {
		for (const input of ["snapcompact", "snapcompact keep the diffs"]) {
			expect(parseCompactArgs(input)).toEqual({ error: SNAPCOMPACT_RETIREMENT_ERROR });
		}
	});
});
