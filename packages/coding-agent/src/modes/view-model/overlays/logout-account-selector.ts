export interface LogoutAccount {
	credentialId: number;
	provider: string;
	label: string;
	detail: string;
	type: "api_key" | "oauth";
	active: boolean;
}
