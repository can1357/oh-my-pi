import { describe, expect, it } from "bun:test";
import { bunUpgradeNotice } from "@oh-my-pi/pi-utils/dirs";

describe("bunUpgradeNotice", () => {
	it("recommends upgrading below Bun 1.4.0", () => {
		expect(bunUpgradeNotice("1.3.14")).toContain("1.3.14");
	});

	it("stays silent from Bun 1.4.0 on", () => {
		expect(bunUpgradeNotice("1.4.0")).toBeUndefined();
		expect(bunUpgradeNotice("1.4.2")).toBeUndefined();
	});
});
