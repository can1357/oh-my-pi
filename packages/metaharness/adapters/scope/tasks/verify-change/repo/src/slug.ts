/**
 * URL slug for a link title: lowercase ASCII letters and digits, words joined by single dashes,
 * no dash at either end. Accented letters lose their accent ("Crème" → "creme").
 */
export function slugify(title: string): string {
	return title
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z]+/g, "-")
		.replace(/^-|-$/g, "");
}
