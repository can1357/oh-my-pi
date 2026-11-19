import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { LocalProtocolOptions } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { loadOverallPlanReference } from "@oh-my-pi/pi-coding-agent/plan-mode/plan-handoff";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("loadOverallPlanReference", () => {
	let tmpDir: string;
	let artifactsDir: string;
	let localProtocolOptions: LocalProtocolOptions;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-handoff-"));
		artifactsDir = path.join(tmpDir, "artifacts");
		await fs.mkdir(path.join(artifactsDir, "local"), { recursive: true });
		localProtocolOptions = {
			getArtifactsDir: () => artifactsDir,
			getSessionId: () => "session-z",
		};
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("returns the plan path and full contents when the reference file exists", async () => {
		const body = "# WP migration\n\n1. Migrate the store\n2. Update callers";
		await Bun.write(path.join(artifactsDir, "local", "wp-migration.md"), body);

		const ref = await loadOverallPlanReference("local://wp-migration.md", localProtocolOptions);

		expect(ref).toEqual({ path: "local://wp-migration.md", content: body });
	});

	it("returns undefined when no plan file exists at the reference path", async () => {
		const ref = await loadOverallPlanReference("local://PLAN.md", localProtocolOptions);

		expect(ref).toBeUndefined();
	});

	it("returns undefined when the plan file is empty or whitespace-only", async () => {
		await Bun.write(path.join(artifactsDir, "local", "PLAN.md"), "   \n\t\n");

		const ref = await loadOverallPlanReference("local://PLAN.md", localProtocolOptions);

		expect(ref).toBeUndefined();
	});
});
