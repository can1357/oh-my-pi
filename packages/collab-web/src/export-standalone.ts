/** React tool cards and session traces included by the hosted export viewer generator. */
import { stringifyJsonIteratively } from "@oh-my-pi/pi-utils/json";
import "./tool-render/standalone";
import "./trace-render/standalone";

declare global {
	/**
	 * pi-utils' JSON writer for `template.js`, the viewer's classic script, which runs after this bundle and cannot
	 * import: it labels a tool call and shows a custom message's content as deep as a session entry nests.
	 */
	var ompJson: { stringifyJsonIteratively: typeof stringifyJsonIteratively };
}

globalThis.ompJson = { stringifyJsonIteratively };
