import type { ToolRenderResultOptions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

type Assert<T extends true> = T;
type _RenderContext = Assert<
	[ToolRenderResultOptions["renderContext"]] extends [Record<string, unknown> | undefined] ? true : false
>;
