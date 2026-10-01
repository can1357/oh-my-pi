import type { CartLine } from "./cart";

export interface Product {
	sku: string;
	name: string;
	priceCents: number;
	stock: number;
}

export const CATALOG: Product[] = [
	{ sku: "MUG-01", name: "Coffee mug", priceCents: 1299, stock: 12 },
	{ sku: "TEE-02", name: "T-shirt", priceCents: 1999, stock: 4 },
	{ sku: "STK-03", name: "Sticker pack", priceCents: 499, stock: 0 },
];

/** Look up a product by SKU. */
export function findProduct(sku: string): Product | undefined {
	return CATALOG.find(product => product.sku === sku);
}

/** Build a cart line, refusing products that are out of stock. */
export function toCartLine(sku: string, qty: number): CartLine {
	const product = findProduct(sku);
	if (!product) throw new Error(`unknown sku ${sku}`);
	if (product.stock < qty) throw new Error(`only ${product.stock} of ${sku} left`);
	return { sku, priceCents: product.priceCents, qty };
}
