import { describe, expect, it } from "bun:test";
import { bunUpgradeNotice } from "@oh-my-pi/pi-coding-agent/cli/bun-upgrade-notice";

describe("bunUpgradeNotice", () => {
	it("recommends upgrading below Bun 1.4.0", () => {
		const notice = bunUpgradeNotice("1.3.14");
		expect(notice).toContain("1.3.14");
		expect(notice).toContain("bun upgrade");
	});

	it("stays silent from Bun 1.4.0 on", () => {
		expect(bunUpgradeNotice("1.4.0")).toBeUndefined();
		expect(bunUpgradeNotice("1.4.2")).toBeUndefined();
	});
});
