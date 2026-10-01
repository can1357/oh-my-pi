import { users } from "../db";
import { log } from "../log";
import { sendEmail } from "../mail";

export async function sendDigest(): Promise<number> {
	let sent = 0;
	for (const user of users.values()) {
		if (!user.active) continue;
		await sendEmail(user.email, "Your weekly digest");
		sent++;
	}
	log.info("digest sent", { sent });
	return sent;
}
