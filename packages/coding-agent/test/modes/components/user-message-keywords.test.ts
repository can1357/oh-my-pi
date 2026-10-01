import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MAGIC_KEYWORDS } from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { chipLabel, modelChipStyle, modelMentionChipLabel } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import { imageReferenceHyperlink } from "@oh-my-pi/pi-tui/prompt/image-references";
import { setMagicKeywords } from "@oh-my-pi/pi-tui/prompt/magic-keywords";
import { getEditorTheme, initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { Container } from "@oh-my-pi/pi-tui";

import { cfgTuiHyperlinks, cfgTuiStickyPrompt } from "@oh-my-pi/pi-coding-agent/modes/settings";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	cfgTuiHyperlinks.set(Settings.instance, "always");
	await initTheme(false);
	// The host registers keywords at startup; without this nothing glows.
	setMagicKeywords(MAGIC_KEYWORDS);
});

afterAll(() => {
	setMagicKeywords([]);
	resetSettingsForTest();
});

afterEach(() => {
	cfgTuiStickyPrompt.set(Settings.instance, "off");
});

function render(text: string): string {
	return new UserMessageComponent(text).render(80).join("\n");
}

function renderThroughUiHelpers(text: string, synthetic = false): string {
	const chatContainer = new Container();
	const sessionManagerMock = { putBlobSync: () => undefined };
	const helpers = new UiHelpers({
		chatContainer,
		sessionManager: sessionManagerMock,
		viewSession: { sessionManager: sessionManagerMock },
		transcriptMessageComponents: new WeakMap(),
		settings: Settings.instance,
	} as unknown as InteractiveModeContext);
	helpers.addMessageToChat({
		role: "user",
		content: [{ type: "text", text }],
		attribution: "user",
		synthetic,
		timestamp: Date.now(),
	});
	const component = chatContainer.children.at(-1);
	if (!component) throw new Error("Expected user message component to be appended");
	return component.render(80).join("\n");
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("UserMessageComponent magic-keyword highlighting", () => {
	it("gradient-paints a magic keyword in the rendered (sent) message bubble", () => {
		const raw = render("please orchestrate the rollout");
		// Visible text is preserved.
		expect(Bun.stripANSI(raw)).toContain("please orchestrate the rollout");
		// The keyword is gradient-painted: a per-character foreground sequence is emitted,
		// and the word no longer survives as a contiguous run in the rendered bytes.
		expect(raw).toContain("\x1b[38");
		expect(raw).not.toContain("orchestrate");
	});

	it("marks only non-synthetic user bubbles as response-turn initiators", () => {
		expect(new UserMessageComponent("user prompt").initiatesResponseTurn).toBe(true);
		expect(new UserMessageComponent("agent input", { synthetic: true }).initiatesResponseTurn).toBe(false);
	});

	it("renders a bounded, marker-free sticky prompt with a styled ellipsis when clipped", () => {
		const component = new UserMessageComponent(`visible first line ${"continued prompt ".repeat(8)}`, {
			semanticResponseGrouping: true,
		});
		const rows = component.renderStickyPrompt(24, 3);
		expect(component.renderStickyPrompt(24, 3)).toBe(rows);
		const visible = Bun.stripANSI(rows.join("\n"));

		expect(rows.length).toBeLessThanOrEqual(3);
		expect(rows.every(row => Bun.stringWidth(Bun.stripANSI(row)) <= 24)).toBe(true);
		expect(visible).toContain("visible first line");
		expect(visible.endsWith("…")).toBe(true);
		expect(rows.join("\n")).not.toContain("\x1b]133;");
		expect(rows.at(-1)).toContain(theme.getBgAnsi("userMessageBg"));
		expect(component.renderStickyPrompt(80, 0)).toEqual([]);
		expect(component.renderStickyPrompt(80, -1)).toEqual([]);
		const renderedRows = component.render(24);
		expect(component.render(24)).toBe(renderedRows);
	});

	it("bounds a live-steered sticky prompt row at width one", () => {
		const rows = new UserMessageComponent("prompt", { liveSteered: true }).renderStickyPrompt(1, 100);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every(row => Bun.stringWidth(Bun.stripANSI(row)) <= 1)).toBe(true);
		expect(rows.join("\n")).not.toContain("\x1b]133;");
	});

	it("does not paint a keyword inside an inline code span", () => {
		const raw = render("ship the `orchestrate` helper");
		expect(Bun.stripANSI(raw)).toContain("orchestrate");
		// Code spans render through the code style as a single run — the word stays intact.
		expect(raw).toContain("orchestrate");
	});

	it("does not paint a keyword inside a fenced code block", () => {
		const raw = render("intro\n```\norchestrate\n```");
		expect(Bun.stripANSI(raw)).toContain("orchestrate");
		expect(raw).toContain("orchestrate");
	});

	it("closes the OSC 133 prompt zone and leaves no command zone open", () => {
		const raw = render("first line\nsecond line");
		expect(raw).toContain("\x1b]133;A\x07");
		expect(raw).toContain("\x1b]133;B\x07");
		// #8030: the command-start marker is required. Terminals latch a sticky
		// `.input` cursor semantic on 133;B that only 133;C clears; without it every
		// later cell stays tagged as prompt input and click-to-move injects arrow
		// keys into the pty.
		expect(raw).toContain("\x1b]133;C\x07");
		// ...but the zone is closed inside the same render, so terminals still cannot
		// group later assistant/tool output under the submitted prompt.
		expect(raw).toContain("\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07");
		expect(raw.endsWith("\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07")).toBe(true);
		// Exactly one balanced command zone per bubble.
		expect(countOccurrences(raw, "\x1b]133;C\x07")).toBe(1);
		expect(countOccurrences(raw, "\x1b]133;D;0\x07")).toBe(1);
	});

	it("closes the OSC 133 command zone for a single-line message too", () => {
		const raw = render("only line");
		expect(raw).toContain("\x1b]133;A\x07");
		expect(raw.endsWith("\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07")).toBe(true);
		expect(countOccurrences(raw, "\x1b]133;C\x07")).toBe(1);
		expect(countOccurrences(raw, "\x1b]133;D;0\x07")).toBe(1);
	});

	it("groups a multiline prompt with its following response when enabled", () => {
		const raw = new UserMessageComponent("first line\nsecond line", { semanticResponseGrouping: true })
			.render(80)
			.join("\n");
		const done = "\x1b]133;D;0\x07";
		const prompt = "\x1b]133;A\x07";
		const command = "\x1b]133;B\x07";
		const output = "\x1b]133;C\x07";
		expect(raw.indexOf(done)).toBeLessThan(raw.indexOf(prompt));
		expect(raw.indexOf(prompt)).toBeLessThan(raw.indexOf(command));
		expect(raw.indexOf(command)).toBeLessThan(raw.indexOf("first line"));
		expect(raw.indexOf("second line")).toBeLessThan(raw.indexOf(output));
		expect(raw.indexOf(done, raw.indexOf(output) + output.length)).toBe(-1);
	});

	it("closes a grouped response when the next prompt begins", () => {
		const first = new UserMessageComponent("first prompt", { semanticResponseGrouping: true }).render(80).join("\n");
		const response = "representative assistant and tool output";
		const second = new UserMessageComponent("second prompt", { semanticResponseGrouping: true })
			.render(80)
			.join("\n");
		const stream = first + response + second;
		const output = "\x1b]133;C\x07";
		const done = "\x1b]133;D;0\x07";
		const secondPrompt = "\x1b]133;A\x07";
		expect(stream.indexOf(output)).toBeLessThan(stream.indexOf(response));
		const close = stream.indexOf(done, stream.indexOf(response) + response.length);
		expect(close).toBeGreaterThan(stream.indexOf(response));
		expect(close).toBeLessThan(stream.indexOf(secondPrompt, close));
	});

	it("uses terminal sticky prompt mode through UiHelpers", () => {
		cfgTuiStickyPrompt.set(Settings.instance, "terminal");
		const raw = renderThroughUiHelpers("terminal prompt");
		const done = "\x1b]133;D;0\x07";
		const prompt = "\x1b]133;A\x07";
		const command = "\x1b]133;B\x07";
		const output = "\x1b]133;C\x07";
		expect(raw.startsWith(done + prompt + command)).toBe(true);
		expect(raw.endsWith(output)).toBe(true);
	});

	it("keeps viewport sticky prompt mode inside its OSC 133 prompt envelope", () => {
		cfgTuiStickyPrompt.set(Settings.instance, "viewport");
		const raw = renderThroughUiHelpers("viewport prompt");
		const prompt = "\x1b]133;A\x07";
		const command = "\x1b]133;B\x07";
		const output = "\x1b]133;C\x07";
		const done = "\x1b]133;D;0\x07";
		expect(raw.startsWith(prompt)).toBe(true);
		expect(raw.indexOf("viewport prompt")).toBeLessThan(raw.indexOf(command));
		expect(raw.endsWith(command + output + done)).toBe(true);
	});

	it("keeps synthetic prompts out of terminal response grouping", () => {
		cfgTuiStickyPrompt.set(Settings.instance, "terminal");
		const synthetic = renderThroughUiHelpers("agent instruction", true);
		const user = renderThroughUiHelpers("real user prompt");
		const response = "real assistant response";
		const done = "\x1b]133;D;0\x07";
		const prompt = "\x1b]133;A\x07";
		const command = "\x1b]133;B\x07";
		const output = "\x1b]133;C\x07";

		// Synthetic/developer bubbles retain their self-contained legacy envelope;
		// only the actual user prompt opens the semantic zone containing the answer.
		expect(synthetic.startsWith(prompt)).toBe(true);
		expect(synthetic.startsWith(done + prompt)).toBe(false);
		expect(synthetic.endsWith(command + output + done)).toBe(true);
		expect(user.startsWith(done + prompt + command)).toBe(true);
		expect(user.endsWith(output)).toBe(true);

		const stream = synthetic + user + response;
		const userOutput = stream.indexOf(output, synthetic.length);
		expect(userOutput).toBeLessThan(stream.indexOf(response));
		expect(stream.indexOf(done, userOutput + output.length)).toBe(-1);
	});

	it("collapses image markers to identity-colored chip tokens in the rendered bubble", () => {
		// Wire format stays `[Image #1, WxH]`; the bubble shows the composer's compact chip.
		const raw = render("please inspect [Image #1, 800x600] before continuing");
		expect(Bun.stripANSI(raw)).toContain(`${chipLabel("image", 1)} before continuing`);
		expect(Bun.stripANSI(raw)).not.toContain("[Image #1");
		expect(raw).toContain("\x1b[1m");
	});

	it("collapses model tags before Markdown and renders the visible label in model styling", () => {
		const label = modelMentionChipLabel("Claude (Fast)");
		const bubbleReset = `${theme.getFgOnBgAnsi("userMessageText", "userMessageBg")}${theme.getBgAnsi("userMessageBg")}`;
		const raw = render('ask <model agent="m1" name="Claude (Fast)"/> then continue');
		expect(Bun.stripANSI(raw)).toContain(`ask ${label} then continue`);
		expect(raw).not.toContain("<model agent=");
		expect(raw).toContain(modelChipStyle(label, bubbleReset));
		expect(raw).toContain(theme.getFgAnsi("statusLineModel"));
	});

	it("wraps image references in file hyperlinks when a blob path is available", () => {
		const imagePath = path.resolve("/tmp/omp-image.png");
		const imageUri = url.pathToFileURL(path.resolve(imagePath)).href;
		const raw = new UserMessageComponent("please inspect [Image #1]", { imageLinks: [imagePath] })
			.render(80)
			.join("\n");
		expect(Bun.stripANSI(raw)).toContain(chipLabel("image", 1));
		expect(raw).toContain("\x1b]8;id=");
		expect(raw).toContain(imageUri);
	});

	it("renders a video marker as a video chip linked to its source", () => {
		const videoPath = path.resolve("/tmp/omp-video.mp4");
		const videoUri = url.pathToFileURL(videoPath).href;
		const raw = new UserMessageComponent("please inspect [Video #1, 960x480]", { imageLinks: [videoPath] })
			.render(80)
			.join("\n");
		expect(Bun.stripANSI(raw)).toContain(chipLabel("video", 1));
		expect(Bun.stripANSI(raw)).not.toContain("[Video #1");
		expect(raw).toContain("\x1b]8;id=");
		expect(raw).toContain(videoUri);
	});

	it("wraps draft editor image references in file hyperlinks when a blob path is available", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.imageReferenceHyperlink = imageReferenceHyperlink;
		const imagePath = path.resolve("/tmp/omp-image.png");
		const imageUri = url.pathToFileURL(path.resolve(imagePath)).href;
		editor.imageLinks = [imagePath];
		editor.setText("please inspect [Image #1]");
		const raw = editor.render(80).join("\n");
		expect(Bun.stripANSI(raw)).toContain("[Image #1]");
		expect(raw).toContain("\x1b]8;id=");
		expect(raw).toContain(imageUri);
	});

	it("rebuilds user messages with image hyperlinks when image links are not precomputed", () => {
		const displayPath = path.resolve("/tmp/abc123.png");
		const displayUri = url.pathToFileURL(path.resolve(displayPath)).href;
		const chatContainer = new Container();
		const sessionManagerMock = {
			putBlobSync: () => ({
				hash: "abc123",
				path: path.resolve("/tmp/abc123"),
				displayPath,
				get ref() {
					return "blob:sha256:abc123";
				},
			}),
		};
		const helpers = new UiHelpers({
			chatContainer,
			sessionManager: sessionManagerMock,
			viewSession: { sessionManager: sessionManagerMock },
			transcriptMessageComponents: new WeakMap(),
			settings: Settings.instance,
		} as unknown as InteractiveModeContext);
		const message: AgentMessage = {
			role: "user",
			content: [
				{ type: "text", text: "please inspect [Image #1]" },
				{ type: "image", data: Buffer.from("image-bytes").toString("base64"), mimeType: "image/png" },
			],
			attribution: "user",
			timestamp: Date.now(),
		};

		helpers.addMessageToChat(message);
		const component = chatContainer.children.at(-1);
		if (!component) throw new Error("Expected user message component to be appended");
		const raw = component.render(80).join("\n");
		expect(Bun.stripANSI(raw)).toContain(chipLabel("image", 1));
		expect(raw).toContain("\x1b]8;id=");
		expect(raw).toContain(displayUri);
	});

	it("highlights paste markers in the draft editor without a hyperlink", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setText("see [Paste #1, +30 lines] now");
		const raw = editor.render(80).join("\n");
		expect(Bun.stripANSI(raw)).toContain("[Paste #1, +30 lines]");
		// The marker label is bold-wrapped (highlighted), unlike surrounding plain text.
		expect(raw).toContain("\x1b[1m[Paste #1, +30 lines]");
		// Paste markers are not clickable, so no OSC-8 hyperlink is emitted (contrast with images).
		expect(raw).not.toContain("\x1b]8;id=");
	});

	it("hyperlinks the metadata-bearing image marker format", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.imageReferenceHyperlink = imageReferenceHyperlink;
		const imagePath = path.resolve("/tmp/omp-image.png");
		const imageUri = url.pathToFileURL(path.resolve(imagePath)).href;
		editor.imageLinks = [imagePath];
		editor.setText("see [Image #1, 800x600] now");
		const raw = editor.render(80).join("\n");
		expect(Bun.stripANSI(raw)).toContain("[Image #1, 800x600]");
		expect(raw).toContain("\x1b]8;id=");
		expect(raw).toContain(imageUri);
	});
});
