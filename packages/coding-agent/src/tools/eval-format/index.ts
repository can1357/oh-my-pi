import type { EvalLanguage } from "../../eval/types";
import { formatJavaScriptForDisplay } from "./javascript";
import { formatPythonForDisplay } from "./python";

export * from "./javascript";
export * from "./python";

/** Formats an arbitrary eval-code prefix for display without changing the executed source. */
export function formatEvalCodeForDisplay(source: string, language: EvalLanguage): string {
	switch (language) {
		case "js":
			return formatJavaScriptForDisplay(source);
		case "python":
			return formatPythonForDisplay(source);
	}
}
