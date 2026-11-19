import { Snowflake } from "@oh-my-pi/pi-utils";
import type { MCPRequestIdFormat } from "./types";

/**
 * Per-transport allocator for outgoing JSON-RPC request ids.
 *
 * JSON-RPC 2.0 permits String and Number ids equally, but the wider MCP
 * ecosystem (reference SDKs included) issues incrementing integers, so servers
 * are best tested against numbers — Apple's `xcrun mcpbridge` even logs
 * `mcpbridge.DecodeError Code=1` and never answers a string id. Integers are
 * therefore the default. `"string"` opts a server back into collision-resistant
 * snowflake ids.
 *
 * The counter is per instance and never reset, so ids stay unique for the life
 * of the transport even though a reconnect rejects and clears every pending
 * request.
 */
export class RequestIdAllocator {
	#previousNumeric = 0;

	next(format: MCPRequestIdFormat | undefined): string | number {
		return format === "string" ? Snowflake.next() : ++this.#previousNumeric;
	}
}
