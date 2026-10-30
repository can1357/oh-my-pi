import type { Model } from "../types";
import { resolveCatalogPolicy } from "./catalog-policy";

/**
 * Model ids on which a refusal's Anthropic fallback-credit token may be
 * redeemed, authored on the `fallback-credit-targets` catalog axis. Empty when
 * no rule assigns targets (the model cannot redeem credit on any fallback).
 */
export function fallbackCreditTargets(model: Model): readonly string[] {
	const value = resolveCatalogPolicy(model).fallbackCreditTargets;
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}
