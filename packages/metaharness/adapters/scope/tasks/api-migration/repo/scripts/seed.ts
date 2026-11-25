import { Store } from "../src/store";

const store = new Store();
const users = [
	{ id: "u1", name: "Ada", email: "ada@example.com" },
	{ id: "u2", name: "Linus", email: "linus@example.com" },
	{ id: "u3", name: "Grace", email: "grace@example.com" },
];

let written = 0;
for (const user of users) {
	store.set(`user:${user.id}`, user, error => {
		if (error) throw error;
		if (++written < users.length) return;
		store.list("user:", (error, entries) => {
			if (error) throw error;
			console.log(`seeded ${entries?.length ?? 0} users`);
		});
	});
}
