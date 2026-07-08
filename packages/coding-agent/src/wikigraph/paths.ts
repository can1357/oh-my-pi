import * as path from "node:path";
import { getAgentDir } from "@pk-nerdsaver-ai/pi-utils";

export function getWikigraphDir(agentDir = getAgentDir()): string {
	return path.join(agentDir, "wikigraph");
}

export function getWikigraphDbPath(agentDir = getAgentDir()): string {
	return path.join(getWikigraphDir(agentDir), "index.sqlite");
}
