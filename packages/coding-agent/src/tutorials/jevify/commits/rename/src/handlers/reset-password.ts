import { users } from "../db";
import { logger } from "../log";
import { sendEmail } from "../mail";

export async function resetPassword(userId: string): Promise<boolean> {
	const user = users.get(userId);
	if (!user) {
		logger.warn("resetPassword: unknown user", { userId });
		return false;
	}
	await sendEmail(user.email, "Reset your password");
	logger.info("password reset sent", { userId });
	return true;
}
