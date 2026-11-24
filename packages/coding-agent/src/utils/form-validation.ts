import { fieldError, type HtmlFormValue } from "../tools/html-form/data";
import type { ChoiceField, FormField } from "../tools/html-form/parse";

/** Prefer an enabled option when a value also belongs to a disabled option. */
export function findChoiceOption(field: ChoiceField, value: string): number {
	const enabled = field.options.findIndex(option => !option.disabled && option.value === value);
	return enabled >= 0 ? enabled : field.options.findIndex(option => option.value === value);
}

/** Apply the form's submit rules after a transport has decoded a field. */
export function validateFormField(field: FormField, value: HtmlFormValue | undefined): void {
	const error = fieldError(field, value);
	if (error) throw new Error(`Form field ${JSON.stringify(field.name)}: ${error}`);
}
