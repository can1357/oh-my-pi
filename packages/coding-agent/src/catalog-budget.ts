export type BudgetedCatalogEntry<T> = T & { descriptionOmitted?: true };

/** Limits descriptions. Malformed budgets fail open to preserve catalogue visibility. */
export function applyCatalogDescriptionBudget<T extends { description: string }>(
	entries: readonly T[],
	budgetChars: number,
): readonly BudgetedCatalogEntry<T>[] {
	if (!Number.isFinite(budgetChars) || budgetChars < 0) return entries;
	if (budgetChars === 0) return entries.map(omitDescription);

	let spent = 0;
	const firstOmitted = entries.findIndex(entry => {
		spent += entry.description.length;
		return spent > budgetChars;
	});
	if (firstOmitted === -1) return entries;

	return entries.map((entry, index) => (index < firstOmitted ? entry : omitDescription(entry)));
}

function omitDescription<T extends { description: string }>(entry: T): BudgetedCatalogEntry<T> {
	return { ...entry, description: "", descriptionOmitted: true };
}
