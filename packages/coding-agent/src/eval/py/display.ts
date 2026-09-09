/**
 * Display bundle rendering shared between the Python runner output and the
 * legacy Jupyter MIME conventions. Pure function, no kernel coupling.
 */
import { htmlToBasicMarkdown } from "../../web/scrapers/types";

/** Status event emitted by prelude helpers for TUI rendering. */
export interface PythonStatusEvent {
	/** Operation name (e.g., "find", "read", "write") */
	op: string;
	/** Additional data fields (count, path, pattern, etc.) */
	[key: string]: unknown;
}

export type KernelDisplayOutput =
	| { type: "json"; data: unknown }
	| { type: "image"; data: string; mimeType: string }
	| { type: "markdown" }
	| { type: "status"; event: PythonStatusEvent };

function normalizeDisplayText(text: string): string {
	return text.endsWith("\n") ? text : `${text}\n`;
}

/** Render a MIME bundle into text + structured outputs. */
export async function renderKernelDisplay(content: Record<string, unknown>): Promise<{
	text: string;
	outputs: KernelDisplayOutput[];
}> {
	// Accept both raw bundles ({"text/plain": ...}) and Jupyter-style
	// content envelopes ({ data: {...} }) so callers don't need to unwrap.
	const data =
		(content.data as Record<string, unknown> | undefined) ?? (content as Record<string, unknown> | undefined);
	if (!data) return { text: "", outputs: [] };

	const outputs: KernelDisplayOutput[] = [];

	// Status events bypass the text path entirely — they exist only for TUI hooks.
	if (data["application/x-omp-status"] !== undefined) {
		const statusData = data["application/x-omp-status"];
		if (statusData && typeof statusData === "object" && "op" in statusData) {
			outputs.push({ type: "status", event: statusData as PythonStatusEvent });
		}
		return { text: "", outputs };
	}

	if (typeof data["image/png"] === "string") {
		outputs.push({ type: "image", data: data["image/png"] as string, mimeType: "image/png" });
	}
	if (typeof data["image/jpeg"] === "string") {
		outputs.push({ type: "image", data: data["image/jpeg"] as string, mimeType: "image/jpeg" });
	}
	if (data["application/json"] !== undefined) {
		outputs.push({ type: "json", data: data["application/json"] });
	}

	// text/markdown takes precedence over text/plain (Markdown objects expose both
	// where text/plain is just the repr).
	if (typeof data["text/markdown"] === "string") {
		outputs.push({ type: "markdown" });
		return { text: normalizeDisplayText(String(data["text/markdown"])), outputs };
	}
	if (typeof data["text/plain"] === "string") {
		return { text: normalizeDisplayText(String(data["text/plain"])), outputs };
	}
	if (data["text/html"] !== undefined) {
		const markdown = (await htmlToBasicMarkdown(String(data["text/html"]))) || "";
		return { text: markdown ? normalizeDisplayText(markdown) : "", outputs };
	}
	return { text: "", outputs };
}
