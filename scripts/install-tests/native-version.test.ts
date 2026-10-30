import { describe, expect, it } from "bun:test";
import { nativeVersionFromBindings } from "./native-version";

const fn = () => {};

describe("native addon release version", () => {
	it("reads the post-link stamp", () => {
		expect(nativeVersionFromBindings({ load: fn, __piNativesBuildVersion: () => "18.4.0" })).toBe("18.4.0");
		expect(nativeVersionFromBindings({ __piNativesBuildVersion: () => null })).toBeUndefined();
	});

	it("normalizes the unique legacy version sentinel", () => {
		expect(nativeVersionFromBindings({ load: fn, __piNativesV17_2_6: fn, other: fn })).toBe("17.2.6");
	});

	it("rejects missing or ambiguous legacy sentinels", () => {
		expect(nativeVersionFromBindings({ load: fn })).toBeUndefined();
		expect(nativeVersionFromBindings({ __piNativesV17_2_6: fn, __piNativesV17_2_7: fn })).toBeUndefined();
	});
});
