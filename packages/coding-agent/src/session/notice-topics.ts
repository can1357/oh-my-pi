import * as path from "node:path";

/** Topic of the one transcript block that reports extension reloads; each new report replaces it. */
export const EXTENSIONS_NOTICE_TOPIC = "extensions";

/** Topic of the one transcript block that reports custom-tool reloads; each new report replaces it. */
export const TOOLS_NOTICE_TOPIC = "tools";

/** Topic of an extension's runtime-error block. A reload that touches the extension retracts it. */
export function extensionErrorTopic(extensionPath: string): string {
	return `extension-error:${path.resolve(extensionPath)}`;
}
