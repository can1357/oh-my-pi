import type { FormFieldTheme } from "../components/form";
import { theme } from "../theme/theme";

/** Shared accent form-field theme used by overlay dialogs. */
export const formTheme: FormFieldTheme = {
	label: text => theme.bold(theme.fg("accent", text)),
	description: text => theme.fg("muted", text),
	error: text => theme.fg("error", text),
	hint: text => theme.fg("dim", text),
};
