import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Executor } from "../sandbox";
import { attachTool } from "./attach";
import { createBashTool } from "./bash";
import { createEditTool } from "./edit";
import { createReadTool } from "./read";
import { createWriteTool } from "./write";

export { setUploadFunction } from "./attach";

export function createMomTools(executor: Executor): AgentTool<any>[] {
	return [
		createReadTool(executor),
		createBashTool(executor),
		createEditTool(executor),
		createWriteTool(executor),
		attachTool,
	];
}
