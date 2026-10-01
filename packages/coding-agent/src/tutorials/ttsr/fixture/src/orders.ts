export interface Order {
	id: string;
	customer: string;
	total: number;
}

export const orders: Order[] = [
	{ id: "A-100", customer: "ada", total: 42.5 },
	{ id: "A-101", customer: "linus", total: 19.99 },
	{ id: "A-102", customer: "grace", total: 120 },
];
