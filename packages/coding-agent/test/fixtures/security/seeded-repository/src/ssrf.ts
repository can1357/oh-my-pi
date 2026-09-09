export async function fetchPreview(userUrl: string): Promise<string> {
	// Deliberately vulnerable fixture: arbitrary schemes/hosts and redirects are accepted.
	return fetch(userUrl, { redirect: "follow" }).then(response => response.text());
}
