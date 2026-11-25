# shop-core

Users, orders, and reports over an in-memory `Store`.

```ts
import { Store } from "./src/store";

const store = new Store();
store.get("user:u1", (error, user) => {
	if (error) throw error;
	console.log(user);
});
```

Seed demo data with `bun scripts/seed.ts`; run the tests with `bun test`.
