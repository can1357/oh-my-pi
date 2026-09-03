import type { EvalLanguage } from "../../eval/types";
import { formatJavaScriptForDisplay } from "./javascript";
import { formatJuliaForDisplay } from "./julia";
import { formatPythonForDisplay } from "./python";
import { formatRubyForDisplay } from "./ruby";

export * from "./javascript";
export * from "./julia";
export * from "./python";
export * from "./ruby";

/** Formats an arbitrary eval-code prefix for display without changing the executed source. */
export function formatEvalCodeForDisplay(source: string, language: EvalLanguage): string {
	switch (language) {
		case "js":
			return formatJavaScriptForDisplay(source);
		case "ruby":
			return formatRubyForDisplay(source);
		case "julia":
			return formatJuliaForDisplay(source);
		case "python":
			return formatPythonForDisplay(source);
	}
}
