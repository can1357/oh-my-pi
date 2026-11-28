export type LogoutAccountAction = "sign-out-local" | "disconnect";

export interface LogoutAccount {
	credentialId: number;
	provider: string;
	label: string;
	detail: string;
	type: "api_key" | "oauth";
	active: boolean;
	connection?: {
		disconnectLabel: string;
		manage?: { label: string; url: string };
	};
}
