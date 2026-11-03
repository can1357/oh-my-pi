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
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Context, Message } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { type AsideProvenanceCarrier, kAsideProvenance } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { obfuscateMessages, obfuscateProviderContext } from "@oh-my-pi/pi-coding-agent/secrets/message-transform";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { DateCwdReminderInjector } from "@oh-my-pi/pi-coding-agent/session/date-cwd-reminder";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
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

	/** Run `[user, ...asides]` through the production `ExtensionRunner` with one context handler. */
	async function throughExtension(handler: string, asides: AgentMessage[]): Promise<AgentMessage[]> {
		const tempDir = TempDir.createSync("@pi-aside-provenance-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		try {
			const extension = path.join(tempDir.path(), "context.ts");
			await Bun.write(extension, `export default function (pi) { pi.on("context", ${handler}); }`);
			const loaded = await loadExtensions([extension], tempDir.path());
			expect(loaded.errors).toHaveLength(0);
			const runner = new ExtensionRunner(
				loaded.extensions,
				loaded.runtime,
				tempDir.path(),
				SessionManager.inMemory(tempDir.path()),
				new ModelRegistry(authStorage),
			);
			return await runner.emitContext([user, ...asides]);
		} finally {
			authStorage.close();
			tempDir.removeSync();
		}
	}
	const holding = (messages: readonly AgentMessage[], token: object) =>
		messages.filter(message => (message as AsideProvenanceCarrier)[kAsideProvenance] === token).length;

	for (const [what, handler] of [
		["changes nothing", "() => {}"],
		["returns a spread of every message", "event => ({ messages: event.messages.map(m => ({ ...m })) })"],
		["drops earlier history and keeps the messages it was given", "event => ({ messages: event.messages.slice(1) })"],
	] as const) {
		it(`survives an extension's context handler that ${what}`, async () => {
			const { aside, token } = markedNotice();
			// The runner's own structured clone drops symbols; it gives each clone its original's identity.
			expect(holding(await throughExtension(handler, [aside]), token)).toBe(1);
		});
	}

	for (const [what, handler] of [
		["rebuilds every message from its JSON", "event => ({ messages: JSON.parse(JSON.stringify(event.messages)) })"],
		["structured-clones what it keeps", "event => ({ messages: structuredClone(event.messages) })"],
	] as const) {
		it(`is lost, not guessed, when a context handler ${what}`, async () => {
			const { aside, token } = markedNotice();
			// Equal bytes at an equal position are not the aside: the notice counts as lost.
			expect(holding(await throughExtension(handler, [aside]), token)).toBe(0);
		});
	}

	it("never moves one notice's identity to an identical notice a handler kept", async () => {
		const first = markedNotice();
		const second = markedNotice();
		const kept = await throughExtension("event => ({ messages: [event.messages[0], event.messages.at(-1)] })", [
			first.aside,
			second.aside,
		]);
		expect(holding(kept, first.token)).toBe(0);
		expect(holding(kept, second.token)).toBe(1);
		const cloned = await throughExtension(
			"event => ({ messages: structuredClone([event.messages[0], event.messages.at(-1)]) })",
			[first.aside, second.aside],
		);
		expect(holding(cloned, first.token)).toBe(0);
		expect(holding(cloned, second.token)).toBe(0);
	});

	it("never gives a notice's identity to a message a handler built in its place", async () => {
		const { aside, token } = markedNotice(undefined, "user");
		const text = JSON.stringify((aside as { content: string }).content);
		const out = await throughExtension(
			`event => ({ messages: event.messages.map(m => m.role === "custom" ? { role: "user", content: ${text}, timestamp: 2 } : m) })`,
			[aside],
		);
		expect(holding(out, token)).toBe(0);
	});
});
