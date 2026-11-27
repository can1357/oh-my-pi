/**
 * Displaceable tool results: a `wait` poll whose watched jobs all still run (the next poll
 * replaces its card) and a final `todo` snapshot (the next update replaces it). The live event
 * path and the transcript replay collapse such runs to their last card the same way.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import { isWaitingPollDetails } from "../../tools/details/wait";
import type { PendingTool } from "../types";

/** The tool a displaceable result can give way to. */
export type DisplaceableToolName = "wait" | "todo";

/** Which tool may displace `tool`'s card; sealed cards and errors stay. */
export function displaceableBy(tool: PendingTool): DisplaceableToolName | undefined {
	const call = tool.call;
	if (!call) return undefined;
	const { result, partial, sealed } = call.facts;
	const current = result();
	if (sealed() || !current || current.isError === true) return undefined;
	if (call.name === "wait" && isWaitingPollDetails(current.details)) return "wait";
	if (call.name === "todo" && !partial() && isRecord(current.details) && Array.isArray(current.details.phases)) {
		return "todo";
	}
	return undefined;
}
