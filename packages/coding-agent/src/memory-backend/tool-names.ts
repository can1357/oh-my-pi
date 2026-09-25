import type { MemoryBackendId } from "./types";
import { XD_URL_PREFIX } from "@oh-my-pi/pi-tui/tools/xd-url";

/** Built-in tools whose availability depends on the selected memory backend. */
export const MEMORY_BACKEND_TOOL_NAMES = ["retain", "recall", "reflect", "memory_edit", "learn"] as const;

/**
 * Tool names each backend's injected developer instructions tell the model to
 * CALL, keyed by backend id.
 *
 * The instructions are imperative prose ("Use `recall` proactively…"), so they
 * are only truthful while every tool they name is in the session's effective
 * tool set: a scope that drops one would otherwise steer the model into a
 * guaranteed unavailable-tool error. Listed per backend because the blocks
 * differ — Hindsight/Mnemopi name `recall`/`retain`/`reflect`, while the local
 * summary block only credits `learn` as the capture source (attribution, not a
 * call to action) and Sharpshooter's decision files are not tool-directed at
 * all.
 *
 * Unreferenced memory tools (`memory_edit`, `learn`) belong to
 * {@link MEMORY_BACKEND_TOOL_NAMES} for tool construction, but scoping them out
 * must NOT suppress instructions that never mention them.
 */
export const MEMORY_INSTRUCTION_TOOL_NAMES: Record<MemoryBackendId, readonly string[]> = {
	off: [],
	local: [],
	hindsight: ["recall", "retain", "reflect"],
	mnemopi: ["recall", "retain", "reflect"],
	sharpshooter: [],
};

/**
 * Prompt references for memory tools: `xd://<name>` when the tool is mounted
 * as an xd:// device (the only way to call it), else its bare name.
 */
export function memoryToolRefs(mountedDevices: readonly { name: string }[] = []): Record<string, string> {
	const mounted = new Set(mountedDevices.map(device => device.name));
	return Object.fromEntries(
		MEMORY_BACKEND_TOOL_NAMES.map(name => [name, mounted.has(name) ? `${XD_URL_PREFIX}${name}` : name]),
	);
}
