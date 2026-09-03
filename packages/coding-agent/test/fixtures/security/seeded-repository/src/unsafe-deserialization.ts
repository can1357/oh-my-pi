export function restorePreferences(serialized: string): object {
	// Deliberately vulnerable fixture: parsed values are merged onto a normal prototype-bearing object.
	return Object.assign({}, JSON.parse(serialized));
}
