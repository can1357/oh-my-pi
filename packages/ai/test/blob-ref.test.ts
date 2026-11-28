import { describe, expect, it } from "bun:test";
import {
	BLOB_HASH_RE,
	BLOB_PREFIX,
	isBlobRef,
	isUnresolvedBlobRef,
	parseBlobRef,
} from "@oh-my-pi/pi-ai/utils/blob-ref";

const HASH = "a".repeat(64);
const REF = `${BLOB_PREFIX}${HASH}`;

describe("blob-ref detector", () => {
	it("accepts a canonical lowercase bare ref", () => {
		expect(isBlobRef(REF)).toBe(true);
		expect(parseBlobRef(REF)).toBe(HASH);
		expect(isUnresolvedBlobRef(REF)).toBe(true);
		expect(BLOB_HASH_RE.test(HASH)).toBe(true);
	});

	it("rejects an uppercase hash that a case-insensitive matcher would accept", () => {
		const upper = `${BLOB_PREFIX}${"A".repeat(64)}`;
		expect(isBlobRef(upper)).toBe(true);
		expect(parseBlobRef(upper)).toBeNull();
		expect(isUnresolvedBlobRef(upper)).toBe(false);
	});

	it("treats a data URL wrapping a valid ref as unresolved", () => {
		expect(isUnresolvedBlobRef(`data:image/png;base64,${REF}`)).toBe(true);
	});

	it("does not treat a https URL or inline base64 as a blob ref", () => {
		expect(isUnresolvedBlobRef("https://cdn.example/shot.png")).toBe(false);
		expect(isUnresolvedBlobRef("data:image/png;base64,ZmFrZQ==")).toBe(false);
		expect(isUnresolvedBlobRef(undefined)).toBe(false);
	});
});
