import { receipt } from "./cart";
import { toCartLine } from "./inventory";

const cart = [toCartLine("MUG-01", 2), toCartLine("TEE-02", 1)];

console.log(receipt(cart));
