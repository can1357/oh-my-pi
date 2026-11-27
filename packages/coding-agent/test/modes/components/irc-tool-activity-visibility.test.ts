import { afterAll, describe, expect, it } from "bun:test";
import type { UserMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/transcript/messages";
import { jsx } from "@oh-my-pi/pi-tui/jsx-runtime";
import { corpusEnvironment, describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { contextDisplay, createInteractiveModeContext, renderTranscript } from "../../helpers/interactive-mode-context";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

const messages: CustomMessage[] = [
	{
		role: "custom",
		customType: "irc:incoming",
		content: "incoming coordination",
		details: { from: "Scout", message: "incoming coordination" },
		display: true,
		timestamp: 1,
	},
	{
		role: "custom",
		customType: "irc:autoreply",
		content: "automatic coordination",
		details: { to: "Scout", body: "automatic coordination" },
		display: true,
		timestamp: 2,
	},
	{
		role: "custom",
		customType: "irc:relay",
		content: "relayed coordination",
		details: { from: "Scout", to: "Builder", body: "relayed coordination" },
		display: true,
		timestamp: 3,
	},
	{
		role: "custom",
		customType: "irc:workpool",
		content: "pooled coordination",
		details: { pool: "Review", to: "Builder", mode: "dispatch", body: "pooled coordination" },
		display: true,
		timestamp: 4,
	},
];

const bodies = messages.map(message => message.content as string);

function expectCoordination(text: string, visible: boolean): void {
	for (const body of bodies) {
		if (visible) expect(text).toContain(body);
		else expect(text).not.toContain(body);
	}
}

/** A fixture context whose transcript renders messages through the real helpers. */
function context() {
	const ctx = createInteractiveModeContext({ settings: Settings.isolated() });
	const helpers = new UiHelpers(ctx);
	ctx.addMessageToChat = (message, options) => helpers.addMessageToChat(message, options);
	return { ctx, helpers, toolActivity: contextDisplay(ctx).toolActivity };
}

describe("IRC tool activity visibility", () => {
	it("hides live cards, including arrivals while hidden, without hiding conversation", async () => {
		const { ctx, toolActivity } = context();
		const controller = new EventController(ctx);
		const render = () => renderTranscript(ctx).join("\n");
		ctx.present(() => jsx("text", { text: "Conversation remains visible" }));
		try {
			await controller.handleEvent({ type: "irc_message", message: messages[0]! });
			expect(render()).toContain(bodies[0]!);
			toolActivity.set("hidden");
			for (const message of messages.slice(1)) await controller.handleEvent({ type: "irc_message", message });
			expectCoordination(render(), false);
			expect(render()).toContain("Conversation remains visible");
			toolActivity.set("detailed");
			expectCoordination(render(), true);
		} finally {
			controller.dispose();
		}
	});

	it("replays stored IRC cards hidden and reveals them on toggle", () => {
		const { ctx, helpers, toolActivity } = context();
		const render = () => renderTranscript(ctx).join("\n");
		toolActivity.set("hidden");
		for (const message of messages) helpers.addMessageToChat(message);
		expectCoordination(render(), false);
		toolActivity.set("detailed");
		expectCoordination(render(), true);
	});

	it("shows a parent steer as an IRC card in the live transcript even when tool activity is hidden", () => {
		const { ctx, helpers, toolActivity } = context();
		const body = "Please check the build";
		const steer: UserMessage = {
			role: "user",
			content: '[Wait interrupted by message]\n<irc from="parent" agent="Main">\nPlease check the build\n</irc>',
			parentIrc: { from: "Main", body },
			attribution: "agent",
			steering: true,
			timestamp: Date.now(),
		};
		toolActivity.set("hidden");
		const [block] = helpers.addMessageToChat(steer);
		if (!block) throw new Error("the steer drew no block");
		const tree = JSON.stringify(describeTree(block.node, corpusEnvironment("dark"), 120));
		expect(tree).toContain('"role":"omp.irc.incoming"');
		expect(tree).toContain("Main");
		expect(tree).toContain(body);
		expect(renderTranscript(ctx).join("\n")).toContain(body);
	});
});
