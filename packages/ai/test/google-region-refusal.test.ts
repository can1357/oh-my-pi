import { describe, expect, it } from "bun:test";
import { isGoogleRegionRefusal } from "@oh-my-pi/pi-ai/utils/google-validation";

const PHRASE = "User location is not supported for the API use";

describe("isGoogleRegionRefusal", () => {
	it("accepts the structured Cloud Code Assist envelope", () => {
		const body = JSON.stringify({
			error: { code: 400, message: `${PHRASE}.`, status: "FAILED_PRECONDITION" },
		});
		expect(isGoogleRegionRefusal(body)).toBe(true);
		// A provider prefix (the thrown message) still exposes the JSON envelope.
		expect(isGoogleRegionRefusal(`Cloud Code Assist API error (400): ${body}`)).toBe(true);
	});

	it("rejects a structured body whose status is not FAILED_PRECONDITION", () => {
		const body = JSON.stringify({
			error: { code: 400, message: `${PHRASE}.`, status: "INVALID_ARGUMENT" },
		});
		expect(isGoogleRegionRefusal(body)).toBe(false);
	});

	it("rejects a structured body that mentions the phrase outside error.message", () => {
		const body = JSON.stringify({
			error: { code: 400, status: "FAILED_PRECONDITION", message: "Other failure." },
			request: { prompt: `${PHRASE}` },
		});
		expect(isGoogleRegionRefusal(body)).toBe(false);
	});

	it("rejects ordinary location fields that do not carry the exact phrase", () => {
		expect(isGoogleRegionRefusal('{"error":{"message":"invalid location field"}}')).toBe(false);
		expect(isGoogleRegionRefusal("location: somewhere")).toBe(false);
		// The phrase is matched exactly (Google's own wording), not case-folded prose.
		expect(isGoogleRegionRefusal("user location is not supported for the api use")).toBe(false);
	});

	it("falls back to the exact phrase for a plain-text or truncated body", () => {
		expect(isGoogleRegionRefusal(`${PHRASE}.`)).toBe(true);
		expect(isGoogleRegionRefusal(`400 FAILED_PRECONDITION: ${PHRASE}`)).toBe(true);
		// A truncated JSON envelope cannot be validated structurally; the phrase is
		// the only signal available.
		expect(isGoogleRegionRefusal(`{"error":{"status":"FAILED_PRECONDITION","message":"${PHRASE}`)).toBe(true);
	});
});
