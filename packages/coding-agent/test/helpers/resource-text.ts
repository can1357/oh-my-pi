import type { InternalResource } from "@oh-my-pi/pi-coding-agent/internal-urls/types";

/** Text a router-resolved resource carries; throws when its handler served bytes. */
export function resourceText(resource: InternalResource<string | Buffer>): string {
	if (typeof resource.content !== "string") {
		throw new Error(`${resource.url} resolved to ${resource.content.length} bytes, not text`);
	}
	return resource.content;
}
