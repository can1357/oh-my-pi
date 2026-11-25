import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { getManagedSkillsDir, getProjectManagedSkillsDir } from "@oh-my-pi/pi-coding-agent/autolearn/managed-skills";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { LearnTool } from "@oh-my-pi/pi-coding-agent/tools/learn";
import { ManageSkillTool } from "@oh-my-pi/pi-coding-agent/tools/manage-skill";
import { TempDir } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";

describe("learn and manage_skill mutation order", () => {
	let temp: TempDir;
	let previousAgentDir: string;

	beforeEach(() => {
		temp = TempDir.createSync("@omp-learn-order-");
		previousAgentDir = getAgentDir();
		setAgentDir(temp.path());
	});

	afterEach(async () => {
		setAgentDir(previousAgentDir);
		await temp.remove();
	});

	function tools(backend: "hindsight" | "local", outbox: Promise<void>) {
		const session: ToolSession = {
			cwd: temp.path(),
			settings: Settings.isolated({ "memory.backend": backend }),
			hasUI: false,
			skipPythonPreflight: true,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getHindsightSessionState: () => ({ enqueueRetain: () => outbox }) as unknown as HindsightSessionState,
		};
		const file = Bun.file(path.join(getProjectManagedSkillsDir(session.cwd), skill.name, "SKILL.md"));
		return { learn: new LearnTool(session), manage: new ManageSkillTool(session), file };
	}

	const skill = {
		action: "create",
		name: "ordered-lesson",
		scope: "project",
		description: "First",
		body: "First",
	} as const;

	it.each(["hindsight", "local"] as const)(
		"keeps a later project delete behind an unscoped %s learn update",
		async backend => {
			const outbox = Promise.withResolvers<void>();
			const { learn, manage, file } = tools(backend, outbox.promise);
			await manage.execute("global", { ...skill, scope: "global", body: "Keep global copy" });
			await manage.execute("project", skill);
			const global = Bun.file(path.join(getManagedSkillsDir(), skill.name, "SKILL.md"));
			const globalBefore = await global.text();
			const results = Promise.all([
				learn.execute("lesson", {
					memory: "Keep this lesson",
					skill: { action: "update", name: skill.name, description: "New", body: "Update the project copy" },
				}),
				manage.execute("delete", { action: "delete", name: skill.name, scope: skill.scope }),
			]);
			outbox.resolve();
			const [updated, deleted] = await results;
			expect(updated.details).toMatchObject({ skill: skill.name, scope: skill.scope });
			expect(deleted.details).toMatchObject({ action: "delete", scope: skill.scope });
			expect(await file.exists()).toBe(false);
			expect(await global.text()).toBe(globalBefore);
		},
	);

	it("skips the skill and releases the name for a later create when the outbox fails", async () => {
		const outbox = Promise.withResolvers<void>();
		const { learn, manage, file } = tools("hindsight", outbox.promise);
		const failure = new Error("outbox is full");
		const results = Promise.allSettled([
			learn.execute("lesson", { memory: "Cannot persist this lesson", skill }),
			manage.execute("retry", { ...skill, body: "Independent create" }),
		]);
		outbox.reject(failure);
		const [lesson, retry] = await results;
		expect(lesson).toEqual({ status: "rejected", reason: failure });
		expect(retry.status).toBe("fulfilled");
		expect(await file.text()).toContain("Independent create");
	});
});
