import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { EvalLanguage, EvalStatusEvent } from "@oh-my-pi/pi-tui/tools/eval";
import { isRecord } from "@oh-my-pi/pi-utils";

/** Kernel-defined tool metadata exposed to task subagents. */
export interface EvalToolDescriptor {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	language: EvalLanguage;
}

/** Result of invoking a kernel-defined tool. */
export type EvalToolInvokeResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Image metadata accepted at the untyped JS/Python display boundary. */
export function evalImageMetadata(value: unknown): Pick<ImageContent, "detail" | "providerFile" | "url"> {
	const metadata: Pick<ImageContent, "detail" | "providerFile" | "url"> = {};
	if (!isRecord(value)) return metadata;
	if (value.detail === "auto" || value.detail === "low" || value.detail === "high" || value.detail === "original") {
		metadata.detail = value.detail;
	}
	if (typeof value.url === "string") metadata.url = value.url;
	const file = value.providerFile;
	if (isRecord(file) && (file.provider === "openai" || file.provider === "anthropic" || file.provider === "google")) {
		metadata.providerFile = { provider: file.provider };
		if (typeof file.id === "string") metadata.providerFile.id = file.id;
		if (typeof file.uri === "string") metadata.providerFile.uri = file.uri;
		if (typeof file.expiresAt === "number" && Number.isFinite(file.expiresAt)) {
			metadata.providerFile.expiresAt = file.expiresAt;
		}
	}
	return metadata;
}

/** Display output captured during eval execution across supported backends. */
export type EvalDisplayOutput =
	| { type: "json"; data: unknown }
	| ImageContent
	| { type: "markdown"; text?: string }
	| { type: "status"; event: EvalStatusEvent };
