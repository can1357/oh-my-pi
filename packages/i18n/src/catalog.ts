export type MessageCatalog = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is MessageCatalog {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlural(value: unknown): value is Readonly<Record<string, string>> {
	if (!isRecord(value) || typeof value.other !== "string") return false;
	return Object.values(value).every(entry => typeof entry === "string");
}

function pathLabel(path: readonly string[]): string {
	return path.join(".");
}

function compareCatalogs(english: unknown, localized: unknown, locale: string, path: string[], errors: string[]): void {
	if (typeof english === "string") {
		if (typeof localized !== "string") {
			errors.push(`${pathLabel(path)}: message shape differs between en and ${locale}`);
		}
		return;
	}

	if (isPlural(english)) {
		if (!isPlural(localized)) {
			errors.push(`${pathLabel(path)}: message shape differs between en and ${locale}`);
			return;
		}
		const englishKeys = Object.keys(english).sort();
		const localizedKeys = Object.keys(localized).sort();
		for (const key of englishKeys) {
			if (!localizedKeys.includes(key)) errors.push(`${pathLabel([...path, key])}: missing in ${locale}`);
		}
		for (const key of localizedKeys) {
			if (!englishKeys.includes(key)) errors.push(`${pathLabel([...path, key])}: extra in ${locale}`);
		}
		return;
	}

	if (!isRecord(english) || !isRecord(localized) || isPlural(localized)) {
		errors.push(`${pathLabel(path)}: message shape differs between en and ${locale}`);
		return;
	}

	const englishKeys = Object.keys(english).sort();
	const localizedKeys = Object.keys(localized).sort();
	for (const key of englishKeys) {
		if (!(key in localized)) {
			errors.push(`${pathLabel([...path, key])}: missing in ${locale}`);
			continue;
		}
		compareCatalogs(english[key], localized[key], locale, [...path, key], errors);
	}
	for (const key of localizedKeys) {
		if (!(key in english)) errors.push(`${pathLabel([...path, key])}: extra in ${locale}`);
	}
}

export function assertCatalogParity(english: MessageCatalog, localized: MessageCatalog, locale: string): void {
	const errors: string[] = [];
	compareCatalogs(english, localized, locale, [], errors);
	if (errors.length > 0) throw new Error(errors.join("; "));
}

function placeholders(value: string): string[] {
	return [...value.matchAll(/\{([A-Za-z0-9_.-]+)\}/g)].map(match => match[1]!).sort();
}

function comparePlaceholders(english: unknown, localized: unknown, locale: string, path: string[]): string[] {
	if (typeof english === "string" && typeof localized === "string") {
		const expected = placeholders(english);
		const actual = placeholders(localized);
		return expected.join("\0") === actual.join("\0")
			? []
			: [`${pathLabel(path)}: placeholders differ between en and ${locale}`];
	}
	if (isPlural(english) && isPlural(localized)) {
		return Object.keys(english).flatMap(key =>
			key in localized ? comparePlaceholders(english[key], localized[key], locale, [...path, key]) : [],
		);
	}
	if (isRecord(english) && isRecord(localized) && !isPlural(english) && !isPlural(localized)) {
		return Object.keys(english).flatMap(key =>
			key in localized ? comparePlaceholders(english[key], localized[key], locale, [...path, key]) : [],
		);
	}
	return [];
}

export function assertMessagePlaceholders(english: MessageCatalog, localized: MessageCatalog, locale: string): void {
	const errors = comparePlaceholders(english, localized, locale, []);
	if (errors.length > 0) throw new Error(errors.join("; "));
}
