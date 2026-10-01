import { users } from "../db";
import { log } from "../log";
import { sendEmail } from "../mail";

export async function resetPassword(userId: string): Promise<boolean> {
	const user = users.get(userId);
	if (!user) {
		log.warn("resetPassword: unknown user", { userId });
		return false;
	}
	await sendEmail(user.email, "Reset your password");
	log.info("password reset sent", { userId });
	return true;
}
