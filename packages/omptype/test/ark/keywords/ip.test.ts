import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";

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

	const ipv6 = type("string.ip.v6");
	expect(ipv6(validIPv6)).toEqual(validIPv6);

	expect(String(Uuidv4(validIPv6))).toBe('must be an IPv4 address (was "2001:0db8:85a3:0000:0000:8a2e:0370:7334")');

	expect(String(ipv6(validIPv4))).toBe('must be an IPv6 address (was "192.168.1.1")');
});

it("invalid ipv6 with empty segments", () => {
	const ipv6 = type("string.ip.v6");
	const out = ipv6("::%8:.-:.:");
	expect(String(out)).toBe('must be an IPv6 address (was "::%8:.-:.:")');
});
