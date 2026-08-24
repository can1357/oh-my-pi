import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import type { TUI } from "@oh-my-pi/pi-tui";
import { resetSettingsForTest, Settings } from "../../../src/config/settings";
import { ChatTranscriptBuilder } from "../../../src/modes/components/chat-transcript-builder";
import { TranscriptContainer } from "../../../src/modes/components/transcript-container";
import { initTheme } from "../../../src/modes/theme/theme";
import type { InteractiveModeContext } from "../../../src/modes/types";
import { buildAsyncProgressDisplayMessage } from "../../../src/modes/utils/transcript-render-helpers";
import { UiHelpers } from "../../../src/modes/utils/ui-helpers";
import {
	type AsyncProgressDetails,
	type AsyncProgressEntry,
	buildAsyncProgressBatchMessage,
} from "../../../src/session/async-job-delivery";
import type { CustomMessage } from "../../../src/session/messages";
import type { SessionMessageEntry } from "../../../src/session/session-entries";

const HOME_PATH = `${os.homedir()}/projects/async-progress/build.log`;
const DISPLAY_PATH = "~/projects/async-progress/build.log";
const RAW_PROGRESS = `stdout\tvalue\nError:\tfailed at ${HOME_PATH}`;
const LONG_PROGRESS_LINE = "x".repeat(500);

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
	vi.restoreAllMocks();
});

function progressMessage(text = RAW_PROGRESS): CustomMessage<AsyncProgressDetails> {
	const entry: AsyncProgressEntry = {
		jobId: "build",
		text,
		job: undefined,
		seq: 1,
		elapsedMs: 1_000,
		epoch: 0,
		delivery: "ambient",
	};
	const message = buildAsyncProgressBatchMessage([entry]);
	if (!message) throw new Error("Expected async progress message");
	return message;
}

describe("async progress transcript display sanitization", () => {
	it("sanitizes tabs and home paths in the live transcript without changing the model payload", () => {
		const message = progressMessage();
		const modelContent = message.content;
		const chatContainer = new TranscriptContainer();
		const ctx = {
			chatContainer,
			toolOutputExpanded: false,
			viewSession: { extensionRunner: undefined },
		} as unknown as InteractiveModeContext;

		new UiHelpers(ctx).addMessageToChat(message);
		const rendered = Bun.stripANSI(chatContainer.render(160).join("\n"));

		expect(rendered).not.toContain("\t");
		expect(rendered).toContain("stdout   value");
		expect(rendered).toContain("Error:   failed");
		expect(rendered).not.toContain(HOME_PATH);
		expect(rendered).toContain(DISPLAY_PATH);
		expect(message.content).toContain(RAW_PROGRESS);
		expect(message.details?.jobs[0]?.text).toBe(RAW_PROGRESS);
		expect(message.content).toBe(modelContent);
	});

	it("sanitizes tabs and home paths in a rebuilt transcript without changing the stored message", () => {
		const message = progressMessage();
		const modelContent = message.content;
		const builder = new ChatTranscriptBuilder({
			ui: {} as TUI,
			cwd: "/workspace",
			requestRender: () => {},
		});
		const entry: SessionMessageEntry = {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-08-22T00:00:00.000Z",
			message,
		};

		builder.rebuild([entry]);
		const rendered = Bun.stripANSI(builder.container.render(160).join("\n"));

		expect(rendered).not.toContain("\t");
		expect(rendered).toContain("stdout   value");
		expect(rendered).toContain("Error:   failed");
		expect(rendered).not.toContain(HOME_PATH);
		expect(rendered).toContain(DISPLAY_PATH);
		expect(entry.message).toBe(message);
		expect(message.content).toContain(RAW_PROGRESS);
		expect(message.details?.jobs[0]?.text).toBe(RAW_PROGRESS);
		expect(message.content).toBe(modelContent);
	});

	it("shortens home paths in file URLs without matching embedded path suffixes or mutating the source", () => {
		const fileUrl = `file://${HOME_PATH}`;
		const embeddedPath = `/mnt${HOME_PATH}`;
		const rawProgress = `artifact: ${fileUrl}\nmounted: ${embeddedPath}`;
		const message = progressMessage(rawProgress);
		const sourceContent = message.content;
		const sourceDetails = JSON.stringify(message.details);

		const displayMessage = buildAsyncProgressDisplayMessage(message);

		expect(displayMessage.content).toContain(`file:///${DISPLAY_PATH}`);
		expect(displayMessage.content).toContain(embeddedPath);
		expect(displayMessage.content).not.toContain(fileUrl);
		expect(message.content).toBe(sourceContent);
		expect(message.details?.jobs[0]?.text).toBe(rawProgress);
		expect(JSON.stringify(message.details)).toBe(sourceDetails);
	});

	it("shortens exact home paths at prose and code boundaries without matching longer components", () => {
		const home = "/Users/alice";
		vi.spyOn(os, "homedir").mockReturnValue(home);
		const longerComponent = `${home}2/project`;
		const punctuationSiblings = [`${home}.backup/log`, `${home}@work/log`, `${home}+work/log`, `${home}$work/log`];
		const embeddedPath = `/mnt${home}/project`;
		const adjacentJson = `{"cwd":"${home}","next":1}`;
		const rawProgress = [
			`space: ${home} next`,
			`period: ${home}.`,
			`backtick: \`${home}\``,
			`longer: ${longerComponent}`,
			adjacentJson,
			...punctuationSiblings.map(sibling => `sibling: ${sibling}`),
			`embedded: ${embeddedPath}`,
		].join("\n");
		const message = progressMessage(rawProgress);

		const displayMessage = buildAsyncProgressDisplayMessage(message);

		expect(displayMessage.content).toContain("space: ~ next");
		expect(displayMessage.content).toContain("period: ~.");
		expect(displayMessage.content).toContain("backtick: `~`");
		expect(displayMessage.content).toContain("{&quot;cwd&quot;:&quot;~&quot;,&quot;next&quot;:1}");
		expect(displayMessage.content).toContain(`longer: ${longerComponent}`);
		for (const sibling of punctuationSiblings) expect(displayMessage.content).toContain(`sibling: ${sibling}`);
		expect(displayMessage.content).toContain(`embedded: ${embeddedPath}`);
		expect(message.details?.jobs[0]?.text).toBe(rawProgress);
	});

	it("shortens mixed-case Windows home paths without exposing the user directory", () => {
		vi.spyOn(os, "homedir").mockReturnValue("C:/Users/Pedro");
		const backslashPath = "c:\\USERS\\pEdRo\\projects\\build.log";
		const slashPath = "C:/users/PEDRO/projects/build.log";
		const message = progressMessage(`native: ${backslashPath}\nportable: ${slashPath}`);

		const displayMessage = buildAsyncProgressDisplayMessage(message);

		expect(displayMessage.content).toContain("native: ~\\projects\\build.log");
		expect(displayMessage.content).toContain("portable: ~/projects/build.log");
		expect(displayMessage.content).not.toMatch(/[\\/]users[\\/]/i);
		expect(message.content).toContain(backslashPath);
		expect(message.content).toContain(slashPath);
	});

	it("bounds every display-only progress line without truncating the model payload", () => {
		const message = progressMessage(`${LONG_PROGRESS_LINE}\n${LONG_PROGRESS_LINE}`);
		const displayMessage = buildAsyncProgressDisplayMessage(message);
		if (typeof displayMessage.content !== "string") throw new Error("Expected string display content");
		const progressLines = displayMessage.content.split("\n").filter(line => line.startsWith("x"));

		expect(progressLines).toHaveLength(2);
		for (const line of progressLines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(110);
		expect(displayMessage.content).not.toContain(LONG_PROGRESS_LINE);
		expect(message.content).toContain(`${LONG_PROGRESS_LINE}\n${LONG_PROGRESS_LINE}`);
	});
});
