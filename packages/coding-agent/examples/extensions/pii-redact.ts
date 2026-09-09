/**
 * PII redaction extension (pattern + lightweight fallback)
 *
 * Demonstrates first-class privacy middleware on the extension event bus:
 *   - tool_result              — scrub tool output (success and error) before it re-enters context
 *   - context                  — rewrite AgentMessage[] before the LLM call
 *   - before_provider_request  — last-mile provider payload scrub (strings + structured objects)
 *
 * This example ships a small regex fallback so it runs with zero deps.
 * For production NER (names, addresses, multilingual PII) point
 * PAW_PII_CMD at the local ProgramAsWeights CLI from:
 *   https://github.com/kvnloo/pii  (integrations/omp package: omp-paw-pii)
 *
 * Complements built-in secrets.enabled (credentials) — does not replace it.
 *
 * Usage:
 *   omp -e packages/coding-agent/examples/extensions/pii-redact.ts
 *   # or: omp plugin link /path/to/pii/integrations/omp
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";

type ToolResultContent = (TextContent | ImageContent)[];

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /\b(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;

/** Keep PAW well under the extension handler timeout (30s). */
const PAW_TIMEOUT_MS = 5_000;

export function regexRedact(text: string, placeholder: string): string {
	return text.replace(EMAIL, placeholder).replace(PHONE, placeholder).replace(SSN, placeholder);
}

/** Build argv for the linked paw-pii CLI (`--placeholder` is a root option). */
export function buildPawArgs(text: string, placeholder: string): string[] {
	return ["--placeholder", placeholder, "redact", "--text", text];
}

/**
 * Preserve multimodal block order: redact each text block in place without
 * joining/moving content across non-text parts.
 */
export function mapTextBlocks(content: unknown, redact: (text: string) => string): unknown {
	if (typeof content === "string") return redact(content);
	if (!Array.isArray(content)) return content;
	return content.map(part => {
		if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
			if (typeof part.text === "string") {
				return { ...part, text: redact(part.text) };
			}
		}
		return part;
	});
}

/** Shape-preserving walk of provider request objects; redacts every string leaf. */
export function redactStructuredPayload(value: unknown, placeholder: string, seen = new WeakSet<object>()): unknown {
	if (typeof value === "string") return regexRedact(value, placeholder);
	if (value == null || typeof value !== "object") return value;
	if (seen.has(value)) return value;
	seen.add(value);
	if (Array.isArray(value)) {
		return value.map(item => redactStructuredPayload(item, placeholder, seen));
	}
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		out[key] = redactStructuredPayload(child, placeholder, seen);
	}
	return out;
}

export async function redactText(pi: ExtensionAPI, text: string, placeholder: string): Promise<string> {
	const cmd = process.env.PAW_PII_CMD;
	if (!cmd) return regexRedact(text, placeholder);
	try {
		const result = await pi.exec(cmd, buildPawArgs(text, placeholder), { timeout: PAW_TIMEOUT_MS });
		if (result.code === 0 && result.stdout) {
			return result.stdout.replace(/\n$/, "");
		}
		// Do not log stderr/stdout — detectors may echo the protected input.
		pi.logger?.warn?.("PAW_PII_CMD failed; falling back to regex", {
			code: result.code,
			killed: result.killed,
		});
	} catch {
		pi.logger?.warn?.("PAW_PII_CMD failed to spawn; falling back to regex");
	}
	return regexRedact(text, placeholder);
}

async function redactToolResultContent(
	pi: ExtensionAPI,
	content: ToolResultContent,
	placeholder: string,
): Promise<ToolResultContent> {
	const next: ToolResultContent = [];
	for (const part of content) {
		if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
			next.push({ ...part, text: await redactText(pi, part.text, placeholder) });
			continue;
		}
		next.push(part);
	}
	return next;
}

async function redactMessageContent(pi: ExtensionAPI, content: unknown, placeholder: string): Promise<unknown> {
	if (typeof content === "string") {
		return await redactText(pi, content, placeholder);
	}
	if (!Array.isArray(content)) return content;
	const next: unknown[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
			if (typeof (part as { text?: unknown }).text === "string") {
				next.push({
					...(part as object),
					text: await redactText(pi, (part as { text: string }).text, placeholder),
				});
				continue;
			}
		}
		next.push(part);
	}
	return next;
}

export default function piiRedactExtension(pi: ExtensionAPI) {
	pi.setLabel("PII Redaction (example)");
	const placeholder = process.env.PAW_PII_PLACEHOLDER || "[PII]";
	let enabled = process.env.PAW_PII_DISABLE !== "1";

	pi.registerCommand("pii", {
		description: "Toggle example PII redaction middleware",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			ctx.ui.notify(enabled ? "PII redaction on" : "PII redaction off", "info");
		},
	});

	pi.on("tool_result", async event => {
		if (!enabled) return;
		// Error results are model-visible and persisted; scrub them too.
		const redacted = await redactToolResultContent(pi, event.content, placeholder);
		if (redacted === event.content) return;
		return { content: redacted };
	});

	pi.on("context", async event => {
		if (!enabled || !Array.isArray(event.messages)) return;
		const messages = [];
		for (const message of event.messages) {
			if (!message || typeof message !== "object") {
				messages.push(message);
				continue;
			}
			if (!("content" in message)) {
				messages.push(message);
				continue;
			}
			const content = await redactMessageContent(pi, (message as { content?: unknown }).content, placeholder);
			messages.push({ ...message, content } as typeof message);
		}
		return { messages };
	});

	pi.on("before_provider_request", async event => {
		if (!enabled || event.payload == null) return;
		if (typeof event.payload === "string") {
			return await redactText(pi, event.payload, placeholder);
		}
		if (typeof event.payload === "object") {
			return redactStructuredPayload(event.payload, placeholder);
		}
		return undefined;
	});
}
