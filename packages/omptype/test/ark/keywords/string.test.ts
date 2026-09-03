import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";

it("alpha", () => {
	const Alpha = type("string.alpha");
	expect(Alpha("user")).toBe("user");
	expect(String(Alpha("user123"))).toBe('must be only letters (was "user123")');
});

it("alphanumeric", () => {
	const Alphanumeric = type("string.alphanumeric");
	expect(Alphanumeric("user123")).toBe("user123");
	expect(Alphanumeric("user")).toBe("user");
	expect(Alphanumeric("123")).toBe("123");
	expect(String(Alphanumeric("abc@123"))).toBe('must be only letters and digits 0-9 (was "abc@123")');
});

it("hex", () => {
	const Hex = type("string.hex");
	expect(Hex("1fA3")).toBe("1fA3");
	expect(String(Hex("0x1A3"))).toBe('must be hex characters only (was "0x1A3")');
	expect(String(Hex("V29.yZA"))).toBe('must be hex characters only (was "V29.yZA")');
	expect(String(Hex("fn5-"))).toBe('must be hex characters only (was "fn5-")');
});

it("base64", () => {
	const B64 = type("string.base64");
	expect(B64("fn5+")).toBe("fn5+");
	expect(B64("V29yZA==")).toBe("V29yZA==");
	expect(String(B64("V29yZA"))).toBe('must be base64-encoded (was "V29yZA")');
	expect(String(B64("V29.yZA"))).toBe('must be base64-encoded (was "V29.yZA")');
	expect(String(B64("fn5-"))).toBe('must be base64-encoded (was "fn5-")');

	const B64url = type("string.base64.url");
	expect(B64url("fn5-")).toBe("fn5-");
	expect(B64url("V29yZA")).toBe("V29yZA");
	expect(B64url("V29yZA==")).toBe("V29yZA==");
	expect(B64url("V29yZA%3D%3D")).toBe("V29yZA%3D%3D");
	expect(String(B64url("V29.yZA"))).toBe('must be base64url-encoded (was "V29.yZA")');
	expect(String(B64url("fn5+"))).toBe('must be base64url-encoded (was "fn5+")');
});

it("digits", () => {
	const Digits = type("string.digits");
	expect(Digits("123")).toBe("123");
	expect(String(Digits("user123"))).toBe('must be only digits 0-9 (was "user123")');
});

it("email", () => {
	const Email = type("string.email");
	expect(Email("shawn@mail.com")).toBe("shawn@mail.com");
	expect(String(Email("shawn@email"))).toBe('must be an email address (was "shawn@email")');
});

it("credit card", () => {
	const validCC = "5489582921773376";
	expect(type.string.creditCard(validCC)).toEqual(validCC);
	// Regex validation
	expect(String(type.string.creditCard("0".repeat(16)))).toBe('must be a credit card number (was "0000000000000000")');
	// Luhn validation
	expect(String(type.string.creditCard(`${validCC.slice(0, -1)}0`))).toBe(
		'must be a credit card number (was "5489582921773370")',
	);
});

it("semver", () => {
	expect(type.string.semver("1.0.0")).toBe("1.0.0");
	expect(String(type.string.semver("-1.0.0"))).toBe('must be a semantic version (was "-1.0.0")');
});

describe("ip", () => {
	const validIPv4 = "192.168.1.1";
	const validIPv6 = "2001:0db8:85a3:0000:0000:8a2e:0370:7334";

	it("root", () => {
		const Ip = type("string.ip");

		expect(Ip(validIPv4)).toEqual(validIPv4);

		expect(Ip(validIPv6)).toEqual(validIPv6);

		expect(String(Ip("192.168.1.256"))).toBe('must be an IPv4 address or an IPv6 address (was "192.168.1.256")');
		expect(String(Ip("2001:0db8:85a3:0000:0000:8a2e:0370:733g"))).toBe(
			'must be an IPv4 address or an IPv6 address (was "2001:0db8:85a3:0000:0000:8a2e:0370:733g")',
		);
	});

	it("version subtype", () => {
		const Uuidv4 = type("string.ip.v4");

		expect(Uuidv4(validIPv4)).toEqual(validIPv4);
		expect(String(Uuidv4("1234"))).toBe('must be an IPv4 address (was "1234")');

		expect(type.string.ip.v6(validIPv6)).toEqual(validIPv6);

		expect(String(Uuidv4(validIPv6))).toBe('must be an IPv4 address (was "2001:0db8:85a3:0000:0000:8a2e:0370:7334")');

		expect(String(type.string.ip.v6(validIPv4))).toBe('must be an IPv6 address (was "192.168.1.1")');
	});
});
