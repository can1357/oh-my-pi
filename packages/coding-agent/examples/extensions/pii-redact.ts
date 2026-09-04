/**
 * PII redaction extension (pattern + lightweight fallback)
 *
 * Demonstrates first-class privacy middleware on the extension event bus:
 *   - tool_result              — scrub tool output before it re-enters context
 *   - context                  — rewrite AgentMessage[] before the LLM call
 *   - before_provider_request  — last-mile provider payload scrub
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

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /\b(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;

function regexRedact(text: string, placeholder: string): string {
	return text.replace(EMAIL, placeholder).replace(PHONE, placeholder).replace(SSN, placeholder);
}

function collectText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
			if (typeof part.text === "string") parts.push(part.text);
		}
	}
	return parts.join("\n");
}

function mapText(content: unknown, redacted: string): unknown {
	if (typeof content === "string") return redacted;
	if (!Array.isArray(content)) return content;
	let replaced = false;
	return content.map((part) => {
		if (part && typeof part === "object" && "type" in part && part.type === "text") {
			if (!replaced) {
				replaced = true;
				return { ...part, text: redacted };
			}
			return { ...part, text: "" };
		}
		return part;
	});
}

async function redactText(pi: ExtensionAPI, text: string, placeholder: string): Promise<string> {
	const cmd = process.env.PAW_PII_CMD;
	if (cmd) {
		const result = await pi.exec(cmd, ["redact", "--text", text, "--placeholder", placeholder], {});
		if (result.code === 0 && result.stdout) {
			return result.stdout.replace(/\n$/, "");
		}
		pi.logger?.warn?.("PAW_PII_CMD failed; falling back to regex", {
			code: result.code,
			stderr: result.stderr,
		});
	}
	return regexRedact(text, placeholder);
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

	pi.on("tool_result", async (event) => {
		if (!enabled || event.isError) return;
		const blob = collectText(event.content);
		if (blob.length < 3) return;
		const redacted = await redactText(pi, blob, placeholder);
		if (redacted === blob) return;
		return { content: mapText(event.content, redacted) };
	});

	pi.on("context", async (event) => {
		if (!enabled || !Array.isArray(event.messages)) return;
		const messages = [];
		for (const message of event.messages) {
			if (!message || typeof message !== "object") {
				messages.push(message);
				continue;
			}
			const next = { ...message };
			if ("content" in next) {
				const blob = collectText(next.content);
				if (blob) {
					const redacted = await redactText(pi, blob, placeholder);
					next.content = mapText(next.content, redacted);
				}
			}
			messages.push(next);
		}
		return { messages };
	});

	pi.on("before_provider_request", async (event) => {
		if (!enabled || event.payload == null) return;
		if (typeof event.payload === "string") {
			return await redactText(pi, event.payload, placeholder);
		}
		// Opaque provider bodies: best-effort JSON string walk is left to the
		// full omp-paw-pii plugin. Keep the example focused on message content.
		return undefined;
	});
}
