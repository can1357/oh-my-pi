import type * as CodingAgent from "../index";

/** Load the host SDK only when an extension, hook, command, or custom tool accesses its injected `pi` API. */
export function getCodingAgentApi(): typeof CodingAgent {
	return require("../index");
}
