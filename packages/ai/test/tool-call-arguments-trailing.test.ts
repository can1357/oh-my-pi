import { describe, expect, it } from "bun:test";
import { parseToolCallArguments } from "../src/utils/tool-call-arguments";

// Shape of a real failure: one complete object followed by a duplicated closer.
const REAL_HEAD = `{"data": {"status":"done","commit":"abc123",` + `"commit_message":"fix: example commit message"}`;

describe("parseToolCallArguments trailing characters", () => {
	it("accepts one complete object plus a stray duplicated closer", () => {
		const raw = `${REAL_HEAD}}}`;
		const parsed = parseToolCallArguments(raw) as Record<string, unknown>;
		expect((parsed.data as Record<string, unknown>).status).toBe("done");
		expect("__parseError" in parsed).toBe(false);
	});

	it("keeps the rejection with a resend hint when the suffix carries content", () => {
		const raw = `${REAL_HEAD}} {"second":1}`;
		const parsed = parseToolCallArguments(raw) as Record<string, unknown>;
		expect(typeof parsed.__parseError).toBe("string");
		expect(parsed.__parseError as string).toMatch(/Unexpected trailing characters at position/);
		expect(parsed.__parseError as string).toMatch(/Resend exactly one JSON object/);
	});
});
