import type { Store } from "./store";

export interface User {
	id: string;
	name: string;
	email: string;
}

export function createUser(store: Store, user: User): Promise<void> {
	return new Promise((resolve, reject) => {
		store.set(`user:${user.id}`, user, error => (error ? reject(error) : resolve()));
	});
}

export function getUser(store: Store, id: string): Promise<User | undefined> {
	return new Promise((resolve, reject) => {
		store.get(`user:${id}`, (error, doc) => (error ? reject(error) : resolve(doc as User | undefined)));
	});
}

export function listUsers(store: Store): Promise<User[]> {
	return new Promise((resolve, reject) => {
		store.list("user:", (error, entries) => {
			if (error) return reject(error);
			resolve((entries ?? []).map(([, doc]) => doc as User));
		});
	});
}
