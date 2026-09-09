import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";

const validUuidV4 = "f70b8242-dd57-4e6b-b0b7-649d997140a0";

const validUuidV5 = "f70b8242-dd57-5e6b-b0b7-649d997140a0";

it("root", () => {
	const Uuid = type("string.uuid");
	expect(Uuid(validUuidV4)).toEqual(validUuidV4);
	expect(String(Uuid("1234"))).toBe('must be a UUID (was "1234")');
});

it("version subtype", () => {
	const Uuidv4 = type("string.uuid.v4");

	expect(Uuidv4(validUuidV4)).toEqual(validUuidV4);
	expect(String(Uuidv4("1234"))).toBe('must be a UUIDv4 (was "1234")');

	expect(type.string.uuid.v5(validUuidV5)).toEqual(validUuidV5);

	expect(String(Uuidv4(validUuidV5))).toBe('must be a UUIDv4 (was "f70b8242-dd57-5e6b-b0b7-649d997140a0")');
});

it("rejects partial matches", () => {
	const Uuid = type("string.uuid");
	expect(String(Uuid("dbb1e8e0-40fc-4c14-87eb-61b25d166a1b extra"))).toBe("must be a UUID (was a string (length 42))");
	expect(String(Uuid("prefix dbb1e8e0-40fc-4c14-87eb-61b25d166a1b"))).toBe(
		"must be a UUID (was a string (length 43))",
	);
});
