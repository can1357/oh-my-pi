import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { getLesson } from "@oh-my-pi/pi-coding-agent/tutorials/catalog";
import { TutorialProgressStore } from "@oh-my-pi/pi-coding-agent/tutorials/progress";
import { TempDir } from "@oh-my-pi/pi-utils";

const basics = getLesson("basics")!;

describe("TutorialProgressStore", () => {
	it("persists completed steps so a reload resumes at the first unfinished step", async () => {
		using dir = TempDir.createSync("@pi-tutorial-progress-");
		const file = path.join(dir.path(), "tutorials.json");
		const store = await TutorialProgressStore.load(file);
		await store.begin("basics", "/sandbox/basics", "/sessions/basics.jsonl");
		await store.completeStep("basics", basics.steps[0]!.id);

		const reloaded = await TutorialProgressStore.load(file);
		expect(reloaded.nextStep(basics)).toBe(basics.steps[1]);
		expect(reloaded.lessonForSession("/sessions/basics.jsonl")).toBe("basics");
		expect(reloaded.get("basics")?.finished).toBe(false);
	});

	it("keeps the ✓ across a fresh run while resetting its steps", async () => {
		using dir = TempDir.createSync("@pi-tutorial-progress-");
		const file = path.join(dir.path(), "tutorials.json");
		const store = await TutorialProgressStore.load(file);
		for (const step of basics.steps) await store.completeStep("basics", step.id);
		await store.finish("basics");
		expect(store.nextStep(basics)).toBeUndefined();

		await store.begin("basics", "/sandbox/again", "/sessions/again.jsonl");
		const reloaded = await TutorialProgressStore.load(file);
		expect(reloaded.get("basics")).toMatchObject({ finished: true, completed: [] });
		expect(reloaded.nextStep(basics)).toBe(basics.steps[0]);
	});

	it("starts fresh from a malformed file instead of failing /tutorial", async () => {
		using dir = TempDir.createSync("@pi-tutorial-progress-");
		const file = path.join(dir.path(), "tutorials.json");
		await Bun.write(file, JSON.stringify({ version: 1, lessons: { basics: { completed: "nope" } } }));
		const store = await TutorialProgressStore.load(file);
		expect(store.get("basics")).toBeUndefined();
		await store.completeStep("basics", basics.steps[0]!.id);
		expect((await TutorialProgressStore.load(file)).get("basics")?.completed).toEqual([basics.steps[0]!.id]);
	});
});
