# tiny-shop

A toy checkout: a product catalog, a cart, and a receipt printer.

- `src/money.ts` formats and splits amounts in cents.
- `src/inventory.ts` holds the catalog and builds cart lines.
- `src/cart.ts` totals the cart and prints the receipt.
- `src/main.ts` prints a sample receipt.

Run it with `bun src/main.ts`. It currently crashes with a TypeError.
