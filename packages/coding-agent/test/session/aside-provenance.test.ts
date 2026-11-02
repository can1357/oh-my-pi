/**
 * Contract: a claimable aside's identity (`kAsideProvenance`) survives every
 * transform this repository applies between the agent context and the
 * provider call, so the agent loop's hand-off can tell that the request about
 * to be sent holds that very aside. If a transform lost it, the loop would
 * count a delivered notice as lost (a false warning to the person); if a
 * transform kept it on a message that no longer holds the aside, the loop
 * would count an absent notice as read. Each case runs the production
 * transform on a context carrying one marked aside and asserts the converted
 * or projected message still carries exactly that identity.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Context, Message } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { type AsideProvenanceCarrier, kAsideProvenance } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { obfuscateMessages, obfuscateProviderContext } from "@oh-my-pi/pi-coding-agent/secrets/message-transform";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { DateCwdReminderInjector } from "@oh-my-pi/pi-coding-agent/session/date-cwd-reminder";
import {
	convertToLlm,
	replaceLlmImagesWithText,
	wrapSteeringForModel,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import {
	capArchiveFrameBytes,
	clampProviderContextImageBytes,
	clampProviderContextImages,
	dropUnreadableContextImages,
} from "@oh-my-pi/pi-coding-agent/session/provider-image-budget";
import { normalizeProviderContextImagesForModel } from "@oh-my-pi/pi-coding-agent/utils/image-loading";

const SECRET = "CHILD_SECRET_TOKEN_123456";
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** A due-by notice as the queue builds it, marked the way the agent loop marks a claimable aside. */
function markedNotice(
	content?: unknown,
	attribution: "agent" | "user" = "agent",
): { aside: AgentMessage; token: object } {
	const token = {};
	const aside = {
		role: "custom",
		customType: "subagent-overdue",
		content: content ?? `\`${SECRET}\` (task) is taking longer than you said: 5m.`,
		display: true,
		attribution,
		timestamp: 2,
	} as AgentMessage & AsideProvenanceCarrier;
	aside[kAsideProvenance] = token;
	return { aside, token };
}

const carriers = (messages: readonly Message[], token: object) =>
	messages.filter(message => (message as AsideProvenanceCarrier)[kAsideProvenance] === token);

describe("claimable aside identity through the provider pipeline", () => {
	const model = getBundledModel("openai", "gpt-4o-mini");
	const user: AgentMessage = { role: "user", content: "a real request", timestamp: 1 };

	function converted(content?: unknown, attribution?: "agent" | "user"): { context: Context; token: object } {
		const { aside, token } = markedNotice(content, attribution);
		const messages = convertToLlm(wrapSteeringForModel([user, aside]));
		return { context: { systemPrompt: ["test"], messages }, token };
	}

	it("survives conversion of the custom message", () => {
		const { context, token } = converted();
		expect(carriers(context.messages, token)).toHaveLength(1);
	});

	it("survives redaction that rewrites the aside's text", () => {
		// User-attributed text is what redaction rewrites.
		const { context, token } = converted(undefined, "user");
		const obfuscator = new SecretObfuscator([{ type: "plain", content: SECRET }]);
		const redacted = obfuscateMessages(obfuscator, context.messages);
		expect(JSON.stringify(redacted)).not.toContain(SECRET);
		expect(carriers(redacted, token)).toHaveLength(1);
		const provider = obfuscateProviderContext(obfuscator, context);
		expect(carriers(provider.messages, token)).toHaveLength(1);
	});

	it("survives a transform that splits the aside's text into blocks by spreading the message", () => {
		const { context, token } = converted();
		const split = context.messages.map(message => {
			if (typeof message.content !== "string" && !Array.isArray(message.content)) return message;
			const text =
				typeof message.content === "string"
					? message.content
					: message.content.map(part => (part.type === "text" ? part.text : "")).join("");
			if (!text.includes(SECRET)) return message;
			const half = Math.floor(text.length / 2);
			return {
				...message,
				content: [
					{ type: "text", text: text.slice(0, half) },
					{ type: "text", text: text.slice(half) },
				],
			} as Message;
		});
		expect(carriers(split, token)).toHaveLength(1);
	});

	it("survives every image transform, including one that replaces the aside's image with text", async () => {
		const { context, token } = converted([
			{ type: "text", text: "see the attached frame" },
			{ type: "image", data: PNG_1X1, mimeType: "image/png" },
		]);
		const withoutImages = replaceLlmImagesWithText(context.messages, "Image reading is disabled.");
		// Converting a message with an image may split it in two; each part is the aside.
		expect(carriers(withoutImages, token).length).toBeGreaterThan(0);
		let next: Context = context;
		next = capArchiveFrameBytes(next, model);
		next = clampProviderContextImages(next, model);
		next = await normalizeProviderContextImagesForModel(next, model);
		next = await dropUnreadableContextImages(next, model);
		next = clampProviderContextImageBytes(next, model);
		expect(carriers(next.messages, token).length).toBeGreaterThan(0);
	});

	it("survives the per-request date and cwd reminder, which adds a message of its own", () => {
		const { context, token } = converted();
		const reminded = new DateCwdReminderInjector().transform(context, "2026-11-02", "/work");
		expect(carriers(reminded.messages, token)).toHaveLength(1);
	});

	it("is not given to a message that only quotes the aside's text", () => {
		const { aside, token } = markedNotice();
		const quote: AgentMessage = {
			role: "user",
			content: (aside as { content: string }).content,
			timestamp: 3,
		};
		const messages = convertToLlm([user, quote]);
		expect(carriers(messages, token)).toHaveLength(0);
	});
});
