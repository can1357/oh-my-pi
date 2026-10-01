export interface Order {
	id: string;
	userId: string;
	total: number;
	status: "open" | "paid" | "refunded" | "cancelled";
}

export interface User {
	id: string;
	email: string;
	active: boolean;
	balance: number;
}

export interface Session {
	id: string;
	userId: string;
	expiresAt: number;
}

export const orders = new Map<string, Order>();
export const users = new Map<string, User>();
export const sessions = new Map<string, Session>();
export const carts = new Map<string, string[]>();
