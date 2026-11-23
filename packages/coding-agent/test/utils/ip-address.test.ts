import { describe, expect, it } from "bun:test";
import { isHostLocalAddress, isPublicAddress } from "../../src/utils/ip-address";

describe("isPublicAddress", () => {
	it("accepts ordinary public addresses", () => {
		for (const address of [
			"8.8.8.8",
			"93.184.215.14",
			"198.51.101.1",
			"203.0.114.1",
			"192.0.3.1",
			"::ffff:8.8.8.8",
			"::ffff:0:808:808",
			"64:ff9b::808:808",
			"2606:4700:4700::1111",
			"2001:4860:4860::8888",
			"2001:1::1",
			"2001:3::1",
			"2002:808:808::",
		]) {
			expect({ address, public: isPublicAddress(address) }).toEqual({ address, public: true });
		}
	});

	it("rejects IPv4 TEST-NET-1/2/3", () => {
		for (const address of ["192.0.2.0", "192.0.2.255", "198.51.100.7", "203.0.113.200", "::ffff:192.0.2.1"]) {
			expect({ address, public: isPublicAddress(address) }).toEqual({ address, public: false });
		}
	});

	it("rejects special-purpose IPv6 ranges", () => {
		for (const address of [
			"::ffff:0:0:0", // SIIT with 0.0.0.0
			"::ffff:0:7f00:1", // SIIT wrapping loopback
			"::ffff:0:a00:1", // SIIT wrapping private
			"::ffff:0:c000:201", // SIIT wrapping TEST-NET-1
			"64:ff9b:1::1", // local-use NAT64
			"64:ff9b:1:ffff:ffff:ffff:ffff:ffff",
			"2001::1", // Teredo
			"2001:0:4136:e378:8000:63bf:3fff:fdd2",
			"100::1", // discard-only
			"100::ffff:ffff:ffff:ffff",
			"2001:db8::1", // documentation
			"2001:db8:ffff::1",
			"2001:2::1", // benchmarking
			"2001:2:0:ffff::1",
			"::8.8.8.8", // IPv4-compatible ::/96
			"::",
			"::1",
		]) {
			expect({ address, public: isPublicAddress(address) }).toEqual({ address, public: false });
		}
	});

	it("decodes the IPv4 address embedded in SIIT but leaves it public when it is", () => {
		expect(isPublicAddress("::ffff:0:808:808")).toBe(true);
		expect(isPublicAddress("::ffff:0:7f00:1")).toBe(false);
	});

	it("rejects non-literals", () => {
		expect(isPublicAddress("example.com")).toBe(false);
	});
});

describe("isHostLocalAddress", () => {
	it("treats SIIT-wrapped loopback, unspecified and link-local as host-local", () => {
		for (const address of ["::ffff:0:7f00:1", "::ffff:0:0:0", "::ffff:0:a9fe:a9fe"]) {
			expect({ address, local: isHostLocalAddress(address) }).toEqual({ address, local: true });
		}
	});

	it("does not treat SIIT-wrapped public or private addresses as host-local", () => {
		for (const address of ["::ffff:0:808:808", "::ffff:0:a00:1"]) {
			expect({ address, local: isHostLocalAddress(address) }).toEqual({ address, local: false });
		}
	});

	it("keeps existing wrappers host-local", () => {
		for (const address of [
			"127.0.0.1",
			"::1",
			"::",
			"::ffff:127.0.0.1",
			"64:ff9b::7f00:1",
			"64:ff9b:1::7f00:1",
			"2002:7f00:1::",
			"fe80::1",
		]) {
			expect({ address, local: isHostLocalAddress(address) }).toEqual({ address, local: true });
		}
	});

	it("does not treat TEST-NET or documentation ranges as host-local", () => {
		for (const address of ["192.0.2.1", "2001:db8::1", "2001::1", "64:ff9b:1::808:808"]) {
			expect({ address, local: isHostLocalAddress(address) }).toEqual({ address, local: false });
		}
	});
});
