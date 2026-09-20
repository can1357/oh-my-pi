import jevifyNotice from "../prompts/system/jevify-notice.md" with { type: "text" };

/** Hidden system notice appended after a user message that mentions "jevify". */
export const JEVIFY_NOTICE: string = jevifyNotice.trim();
