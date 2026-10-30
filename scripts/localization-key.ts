const contextSeparator = "\u0004";
const semanticContext = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

/** Contexts describe message meaning, never its source location or implementation symbol. */
export function localizationKey(
	source: string,
	translation: string,
	catalog: Readonly<Record<string, string>>,
	context?: string,
): string {
	const [english, embeddedContext, extra] = source.split(contextSeparator);
	if (extra !== undefined || (embeddedContext !== undefined && !semanticContext.test(embeddedContext))) {
		throw new Error(`Invalid semantic translation context: ${source}`);
	}
	if (context !== undefined && !semanticContext.test(context)) {
		throw new Error(`Invalid semantic translation context: ${context}`);
	}
	if (context !== undefined && embeddedContext !== undefined && context !== embeddedContext) {
		throw new Error(`Conflicting semantic translation contexts: ${source} and ${context}`);
	}
	const selectedContext = context ?? embeddedContext;
	const key = selectedContext === undefined ? english : `${english}${contextSeparator}${selectedContext}`;
	if (catalog[key] !== undefined && catalog[key] !== translation) {
		throw new Error(`Translation conflict for ${JSON.stringify(key)}; provide an explicit meaning-based context`);
	}
	return key;
}
