import { bold } from "./bold";
import { italic } from "./italic";
import { link } from "./link";
import type { InlineRule } from "./rule";

/** Inline rules in application order: links first, so their text can hold emphasis. */
export const RULES: InlineRule[] = [link, bold, italic];
