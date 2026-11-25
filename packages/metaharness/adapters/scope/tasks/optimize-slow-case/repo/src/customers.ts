import type { Customer } from "./data";

/** Region of a customer; ids match case-insensitively. `UNKNOWN` when the customer is not on file. */
export function regionOf(customers: readonly Customer[], customerId: string): string {
	const customer = customers.find(candidate => candidate.id.toLowerCase() === customerId.toLowerCase());
	return customer?.region ?? "UNKNOWN";
}
