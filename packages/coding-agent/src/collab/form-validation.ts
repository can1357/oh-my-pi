import { choiceValue, textValue, type HtmlFormData } from "../tools/html-form/data";
import type { HtmlForm } from "../tools/html-form/parse";
import { findChoiceOption, validateFormField } from "../utils/form-validation";

/** Collab sends a state for every field, including distinct indices for duplicate option values. */
export function validateFormData(form: HtmlForm, submitted: unknown): HtmlFormData {
	if (typeof submitted !== "object" || submitted === null || Array.isArray(submitted))
		throw new Error("Form response must carry field states");
	if (
		Object.keys(submitted).length !== 1 ||
		!("fields" in submitted) ||
		!Array.isArray(submitted.fields) ||
		submitted.fields.length !== form.fields.length
	)
		throw new Error("Form response must carry one state per field");
	const data: HtmlFormData = Object.assign(Object.create(null), Object.fromEntries(form.hidden));
	for (const [index, field] of form.fields.entries()) {
		const state: unknown = submitted.fields[index];
		let value;
		if (field.kind === "text") {
			if (typeof state !== "string") throw new Error(`Invalid value for ${JSON.stringify(field.name)}`);
			value = textValue(field, state);
		} else {
			if (typeof state !== "object" || state === null || Array.isArray(state))
				throw new Error(`Invalid choice for ${JSON.stringify(field.name)}`);
			if (
				Object.keys(state).some(key => key !== "checked" && key !== "other") ||
				!("checked" in state) ||
				!Array.isArray(state.checked)
			)
				throw new Error(`Invalid choice for ${JSON.stringify(field.name)}`);
			const otherValue = "other" in state ? state.other : undefined;
			const checked = new Set<number>();
			for (const selected of state.checked) {
				if (
					typeof selected !== "number" ||
					!Number.isInteger(selected) ||
					selected < 0 ||
					selected >= field.options.length ||
					checked.has(selected) ||
					field.options[selected]!.disabled
				)
					throw new Error(`Invalid option for ${JSON.stringify(field.name)}`);
				checked.add(selected);
			}
			if (
				(!field.multi && checked.size > 1) ||
				(otherValue !== undefined && (typeof otherValue !== "string" || !field.other))
			)
				throw new Error(`Invalid choice for ${JSON.stringify(field.name)}`);
			const other = typeof otherValue === "string" ? otherValue.trim() : undefined;
			const otherIndex = other ? findChoiceOption(field, other) : -1;
			if (otherIndex >= 0 && field.options[otherIndex]!.disabled)
				throw new Error(`Disabled option for ${JSON.stringify(field.name)}`);
			if (!field.multi && other && checked.size) throw new Error(`Invalid choice for ${JSON.stringify(field.name)}`);
			value = choiceValue(field, checked, other);
		}
		validateFormField(field, value);
		if (field.name && value !== undefined) data[field.name] = value;
	}
	return data;
}
