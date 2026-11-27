import mongoose from "mongoose";
import { Product } from "../models/Product";

// ── Delivery pricing ────────────────────────────────────────────────────────
// MUST match the website: qualifresh-frontend/src/config/site.ts → delivery.freeDeliveryAbove
// and delivery.deliveryCharge (the cart and checkout show the same rule). Pinned by a test.
export const FREE_DELIVERY_ABOVE = 600; // ₹ — subtotal at or above this → free delivery
export const DELIVERY_CHARGE = 50;      // ₹ — charged below FREE_DELIVERY_ABOVE (nothing for an empty order)
export const PRICE_TOLERANCE = 1;       // ₹ — the browser's subtotal/total may differ from the server's by at most this
export const MAX_QUANTITY = 999;

export interface PricedLine { productId: mongoose.Types.ObjectId; name: string; slug: string; quantity: number; price: number; }
export interface Totals { subtotal: number; deliveryCharge: number; total: number; }

/** Line amount in paise: price × weightKg for weighed per-kg lines, otherwise price × quantity. */
export function linePaise(l: { price: number; quantity: number; weightKg?: number | null }): number {
  if (typeof l.weightKg === "number") return Math.round(l.price * 100 * l.weightKg); // rounded to the nearest paisa
  return Math.round(l.price * 100) * l.quantity;
}

/** Subtotal, delivery charge and total, calculated in paise so decimals never drift. */
export function computeTotals(lines: { price: number; quantity: number; weightKg?: number | null }[]): Totals {
  const sub = lines.reduce((s, l) => s + linePaise(l), 0);
  const delivery = sub === 0 || sub >= FREE_DELIVERY_ABOVE * 100 ? 0 : DELIVERY_CHARGE * 100;
  return { subtotal: sub / 100, deliveryCharge: delivery / 100, total: (sub + delivery) / 100 };
}

type PriceResult =
  | { ok: true; items: PricedLine[]; totals: Totals }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Builds the order lines from the DATABASE (name, slug, price) for the products the browser sent,
 * and the totals on the server. The browser's prices/totals are only used to detect a stale cart:
 * if its subtotal or total is more than ₹1 off, nothing is stored and PRICES_CHANGED is returned.
 */
export async function priceOrderItems(rawItems: unknown, client: { subtotal?: unknown; total?: unknown }): Promise<PriceResult> {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return { ok: false, status: 400, body: { message: "Missing required fields" } };
  const label = (i: any) => (i && typeof i.name === "string" && i.name.trim() ? `"${i.name.trim()}"` : "An item");

  for (const i of rawItems as any[]) {
    const q = i?.quantity;
    if (typeof q !== "number" || !Number.isInteger(q) || q < 1 || q > MAX_QUANTITY)
      return { ok: false, status: 400, body: { message: `Invalid quantity for ${label(i)}. Use a whole number from 1 to ${MAX_QUANTITY}.` } };
  }
  const ids = (rawItems as any[]).map(i => i?.productId);
  const docs = await Product.find({ _id: { $in: ids.filter(id => typeof id === "string" && mongoose.isValidObjectId(id)) } })
    .select("name slug price stock isActive").lean();
  const byId = new Map(docs.map((p: any) => [String(p._id), p]));

  for (const i of rawItems as any[]) {
    const p = typeof i?.productId === "string" ? byId.get(i.productId) : undefined;
    if (!p || p.isActive === false)
      return { ok: false, status: 400, body: { message: `${p ? `"${p.name}"` : label(i)} is no longer available. Remove it to proceed.` } };
  }
  // Out of stock: same check and message as before this change.
  const outOfStock = docs.filter((p: any) => p.stock === 0);
  if (outOfStock.length)
    return { ok: false, status: 400, body: { message: `Out of stock: ${outOfStock.map((p: any) => p.name).join(", ")}. Remove to proceed.` } };

  const items: PricedLine[] = (rawItems as any[]).map(i => {
    const p: any = byId.get(i.productId);
    return { productId: p._id, name: p.name, slug: p.slug, quantity: i.quantity, price: p.price };
  });
  const totals = computeTotals(items);

  const off = (v: unknown, server: number) => v !== undefined && v !== null && !(Math.abs(Number(v) - server) <= PRICE_TOLERANCE);
  if (off(client.subtotal, totals.subtotal) || off(client.total, totals.total))
    return { ok: false, status: 409, body: {
      code: "PRICES_CHANGED", message: "Some prices have changed. Please review your cart.",
      items: items.map(l => ({ productId: String(l.productId), name: l.name, price: l.price })),
    } };
  return { ok: true, items, totals };
}
