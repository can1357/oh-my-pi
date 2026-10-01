const outbox: Array<{ to: string; subject: string }> = [];

export async function sendEmail(to: string, subject: string): Promise<void> {
	if (!to.includes("@")) throw new Error(`invalid address: ${to}`);
	await new Promise(resolve => setTimeout(resolve, 10));
	outbox.push({ to, subject });
}

export function sentCount(): number {
	return outbox.length;
}
