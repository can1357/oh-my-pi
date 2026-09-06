import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import type { TUI } from "@oh-my-pi/pi-tui";
import { resetSettingsForTest, Settings } from "../../../src/config/settings";
import type { DaemonSnapshot } from "../../../src/launch/protocol";
import { ChatTranscriptBuilder } from "../../../src/modes/components/chat-transcript-builder";
import { CustomMessageComponent } from "../../../src/modes/components/custom-message";
import { ToolActivityContainer } from "../../../src/modes/components/tool-activity";
import { TranscriptContainer } from "../../../src/modes/components/transcript-container";
import { initTheme } from "../../../src/modes/theme/theme";
import type { InteractiveModeContext } from "../../../src/modes/types";
import {
	buildAsyncProgressBlock,
	buildAsyncProgressDisplayMessage,
	buildLaunchCompletionBlock,
} from "../../../src/modes/utils/transcript-render-helpers";
import { UiHelpers } from "../../../src/modes/utils/ui-helpers";
import {
	type AsyncProgressDetails,
	type AsyncProgressEntry,
	buildAsyncProgressBatchMessage,
} from "../../../src/session/async-job-delivery";
import type { CustomMessage } from "../../../src/session/messages";
import type { SessionMessageEntry } from "../../../src/session/session-entries";
import { PREVIEW_LIMITS } from "../../../src/tools/render-utils";

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

describe("async progress transcript routing", () => {
	// The live path is `UiHelpers.addMessageToChat`, which the event controller
	// calls for every custom `message_start`; the rebuilt path is
	// `ChatTranscriptBuilder.rebuild` over persisted entries. Both must present
	// the compact progress block: a "Background … progress" status row that hides
	// with the rest of tool activity — never the generic bordered custom-message
	// card, which would print the model-facing `<system-notice>` payload.
	it("presents live and rebuilt async-progress messages as the compact progress block", () => {
		const message = progressMessage("line one\nline two");
		if (typeof message.content !== "string" || !message.content.includes("<system-notice>")) {
			throw new Error("Expected the model payload to carry the system-notice wrapper");
		}
		const chatContainer = new TranscriptContainer();
		const ctx = {
			chatContainer,
			toolOutputExpanded: false,
			viewSession: { extensionRunner: undefined },
		} as unknown as InteractiveModeContext;
		new UiHelpers(ctx).addMessageToChat(message);

		const builder = new ChatTranscriptBuilder({ ui: {} as TUI, cwd: "/workspace", requestRender: vi.fn() });
		builder.rebuild([
			{ type: "message", id: "entry-1", parentId: null, timestamp: "2026-08-22T00:00:00.000Z", message },
		]);

		for (const container of [chatContainer, builder.container]) {
			expect(container.children).toHaveLength(1);
			const [block] = container.children;
			expect(block).toBeInstanceOf(ToolActivityContainer);
			expect(block).not.toBeInstanceOf(CustomMessageComponent);
			const rendered = Bun.stripANSI(container.render(160).join("\n"));
			expect(rendered).toContain("Background job progress build (1.0s)");
			expect(rendered).toContain("line two");
			expect(rendered).not.toContain("<system-notice>");
			expect(rendered).not.toContain("<job-progress");
			expect(rendered).not.toContain("async-progress");
			(block as ToolActivityContainer).setToolActivityVisible(false);
			expect(Bun.stripANSI(container.render(160).join("\n")).trim()).toBe("");
		}
	});
});

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
			requestRender: vi.fn(),
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
		expect(displayMessage.content).toContain('{"cwd":"~","next":1}');
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

	it("preserves paths that only embed the home directory as a suffix", () => {
		const embeddedHomePath = `/mnt${HOME_PATH}`;
		const message = progressMessage(`embedded ${embeddedHomePath}\nrooted ${HOME_PATH}`);
		const displayMessage = buildAsyncProgressDisplayMessage(message);
		if (typeof displayMessage.content !== "string") throw new Error("Expected string display content");

		expect(displayMessage.content).toContain(`embedded ${embeddedHomePath}`);
		expect(displayMessage.content).toContain(`rooted ${DISPLAY_PATH}`);
		expect(message.content).toContain(embeddedHomePath);
		expect(message.content).toContain(HOME_PATH);
	});

	it("bounds every display-only progress line without truncating the model payload", () => {
		const message = progressMessage(LONG_PROGRESS_LINE);
		const displayMessage = buildAsyncProgressDisplayMessage(message);
		if (typeof displayMessage.content !== "string") throw new Error("Expected string display content");
		const progressLine = displayMessage.content.split("\n").find(line => line.startsWith("x"));

		expect(progressLine).toBeDefined();
		expect(Bun.stringWidth(progressLine!)).toBeLessThanOrEqual(110);
		expect(displayMessage.content).not.toContain(LONG_PROGRESS_LINE);
		expect(message.content).toContain(LONG_PROGRESS_LINE);
	});

	it("sanitizes and bounds supervised-process names in completion rows", () => {
		const longSuffix = "x".repeat(500);
		const name = `web\t${HOME_PATH}\n${longSuffix}`;
		const daemon: DaemonSnapshot = {
			name,
			id: "daemon-id",
			state: "exited",
			pid: 123,
			createdAt: 1,
			startedAt: 2,
			exitedAt: 3,
			exitCode: 0,
			restartCount: 0,
			outputBytes: 0,
			owner: "owner-session",
			persist: true,
			detached: false,
		};
		const message = {
			role: "custom",
			customType: "launch-completion",
			content: "",
			display: true,
			details: { daemons: [daemon] },
			timestamp: Date.now(),
		} satisfies CustomMessage<{ daemons: DaemonSnapshot[] }>;

		const rendered = Bun.stripANSI(buildLaunchCompletionBlock(message).render(240).join("\n"));

		expect(rendered).not.toContain("\t");
		expect(rendered).not.toContain(HOME_PATH);
		expect(rendered).toContain(DISPLAY_PATH);
		expect(rendered).not.toContain(longSuffix);
		expect(rendered).toContain("Supervised process completed");
	});

	it("caps the collapsed block by bytes below the row cap and expands to the full window", () => {
		// Six max-width lines fit the model-facing preview budget and the 10-row
		// window, yet weigh ~3 KB; the collapsed view must stop at the byte cap.
		const lines = Array.from({ length: 6 }, (_, index) => `${String(index).padStart(2, "0")}${"x".repeat(488)}`);
		const message = progressMessage(lines.join("\n"));
		expect(message.details?.jobs[0]?.text).toBe(lines.join("\n"));
		const component = buildAsyncProgressBlock(message);

		const collapsed = Bun.stripANSI(component.render(600).join("\n"));
		const collapsedRows = collapsed.split("\n").filter(row => /^\s+\d\dx/.test(row));
		expect(collapsed).toContain("… 2 earlier lines");
		expect(collapsedRows.map(row => row.trim().slice(0, 2))).toEqual(["02", "03", "04", "05"]);
		expect(collapsedRows.reduce((sum, row) => sum + Buffer.byteLength(row.trim()), 0)).toBeLessThanOrEqual(
			PREVIEW_LIMITS.PROGRESS_COLLAPSED_BYTES,
		);

		component.setExpanded(true);
		const expanded = Bun.stripANSI(component.render(600).join("\n"));
		expect(expanded).not.toContain("earlier lines");
		expect(expanded.split("\n").filter(row => /^\s+\d\dx/.test(row))).toHaveLength(6);
	});

	it("folds a multi-line process name into one header row", () => {
		const entry: AsyncProgressEntry = {
			jobId: "web\r\nserver\tnode",
			text: "listening",
			job: undefined,
			seq: 1,
			elapsedMs: 1_000,
			epoch: 0,
			delivery: "ambient",
			source: { type: "process", id: "daemon-1", label: "web", startedAt: 0 },
		};
		const message = buildAsyncProgressBatchMessage([entry]);
		if (!message) throw new Error("Expected async progress message");

		const rows = Bun.stripANSI(buildAsyncProgressBlock(message).render(160).join("\n")).split("\n");
		const headerRows = rows.filter(row => row.includes("Background process progress"));

		expect(headerRows).toHaveLength(1);
		expect(headerRows[0]).toContain("web server   node");
		expect(rows.some(row => row.trim().startsWith("server"))).toBe(false);
		expect(rows).toHaveLength(2);
	});
});
