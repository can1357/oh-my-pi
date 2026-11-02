import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { GUARDED_TEST_FILES, isLeak, scanFiles } from "../../../scripts/test-isolation-sweep";

const repoRoot = path.join(import.meta.dir, "../../..");

describe("test isolation", () => {
	// Contract: in the files that install the frozen scheduler clock, no test or hook body touches
	// shared state (a spy install, a describe/module binding write, a global) after an `await`
	// without a prior ownership check in the same await-free run. A body that times out keeps
	// running, so such a touch lands in the next test. `scripts/test-isolation-sweep.ts` is the
	// check; the guard seam is `helpers/test-lifetime.ts` and `TestCleanup.assertLive()`. The
	// oxlint `test-isolation` rule covers the complementary half (cleanup a timeout skips).
	test("every guarded clock-mock file is free of post-await shared leaks", async () => {
		const leaks = (await scanFiles(repoRoot, GUARDED_TEST_FILES))
			.filter(isLeak)
			.map(site => `${site.file}:${site.line} ${site.kind} ${site.detail}`);
		expect(leaks).toEqual([]);
	});
});
