import { afterEach, describe, expect, it } from "bun:test";
import { resumeCommand } from "@oh-my-pi/pi-coding-agent/utils/resume-command";
import { APP_NAME, getActiveProfile, setProfile } from "@oh-my-pi/pi-utils/dirs";

describe("resumeCommand", () => {
	const originalProfile = getActiveProfile();

	afterEach(() => {
		setProfile(originalProfile);
	});

	it("omits the profile flag in the default profile", () => {
		setProfile(undefined);
		expect(resumeCommand("abc123")).toBe(`${APP_NAME} --resume abc123`);
	});

	it("carries the active profile so the emitted hint is runnable verbatim", () => {
		// Profile sessions live in ~/.omp/profiles/<name>/agent, so a resume hint
		// without --profile fails with "Session not found" (issue #9018).
		setProfile("personal");
		expect(resumeCommand("abc123")).toBe(`${APP_NAME} --profile personal --resume abc123`);
	});

	it("restores the session cwd and permits home-directory execution", () => {
		setProfile(undefined);
		expect(resumeCommand("abc123", "/Users/example/project")).toBe(
			`cd '/Users/example/project' && ${APP_NAME} --allow-home --resume abc123`,
		);
	});

	it("combines cwd restoration with the active profile", () => {
		setProfile("personal");
		expect(resumeCommand("abc123", "/Users/example/project")).toBe(
			`cd '/Users/example/project' && ${APP_NAME} --profile personal --allow-home --resume abc123`,
		);
	});

	it("shell-quotes apostrophes in the session cwd", () => {
		setProfile(undefined);
		expect(resumeCommand("abc123", "/tmp/it's here")).toBe(
			`cd '/tmp/it'\\''s here' && ${APP_NAME} --allow-home --resume abc123`,
		);
	});
});
