import type { MathImageRenderRequest, MathImageSvg } from "@oh-my-pi/pi-tui";

export const MATH_RENDERER_ID = "mathjax-4.1.3-tex-scientific-1";
export const MATH_WORKER_TIMEOUT_MS = 10_000;
export const MATH_WORKER_MAX_PENDING = 256;

export type MathWorkerInbound =
	| { type: "ping"; id: number; epoch: number }
	| { type: "render"; id: number; epoch: number; request: MathImageRenderRequest };
export type MathWorkerOutbound =
	| { type: "ready"; rendererId: string }
	| { type: "pong"; id: number; epoch: number }
	| { type: "result"; id: number; epoch: number; result: MathImageSvg }
	| { type: "error"; id: number; epoch: number; error: { name: string; message: string } };

export function isMathWorkerOutbound(value: unknown): value is MathWorkerOutbound {
	if (!value || typeof value !== "object" || !("type" in value)) return false;
	if (value.type === "ready") return "rendererId" in value && typeof value.rendererId === "string";
	if (
		!("id" in value) ||
		!Number.isSafeInteger(value.id) ||
		Number(value.id) <= 0 ||
		!("epoch" in value) ||
		!Number.isSafeInteger(value.epoch) ||
		Number(value.epoch) < 0
	)
		return false;
	if (value.type === "pong") return true;
	if (value.type === "result") {
		if (!("result" in value) || !value.result || typeof value.result !== "object") return false;
		const result = value.result;
		return (
			"svg" in result &&
			typeof result.svg === "string" &&
			"widthEx" in result &&
			typeof result.widthEx === "number" &&
			"heightEx" in result &&
			typeof result.heightEx === "number"
		);
	}
	if (value.type === "error") {
		if (!("error" in value) || !value.error || typeof value.error !== "object") return false;
		return (
			"name" in value.error &&
			typeof value.error.name === "string" &&
			"message" in value.error &&
			typeof value.error.message === "string"
		);
	}
	return false;
}
