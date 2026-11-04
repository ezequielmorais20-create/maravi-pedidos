import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export interface CartLine { skuId: string; productName: string; variantName: string; priceCents: number; imageUrl: string | null; quantity: number; max: number }
interface Ctx {
  lines: CartLine[];
  count: number;
  add(l: Omit<CartLine, 'quantity'>, qty?: number): void;
  setQty(skuId: string, qty: number): void;
  remove(skuId: string): void;
  clear(): void;
}
const KEY = 'maravi.sacola.v1';
const CartCtx = createContext<Ctx>(null as never);
export const useCart = () => useContext(CartCtx);

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>(() => {
    try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; }
  });
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(lines)); } catch { /* sem armazenamento */ } }, [lines]);
  // O preço aqui é só vitrine: o servidor revalida preço e estoque no checkout.
  const add: Ctx['add'] = (l, qty = 1) =>
    setLines((cur) => {
      const ex = cur.find((x) => x.skuId === l.skuId);
      if (ex) return cur.map((x) => (x.skuId === l.skuId ? { ...x, ...l, quantity: Math.min(x.quantity + qty, Math.max(l.max, 1)) } : x));
      return [...cur, { ...l, quantity: Math.min(qty, Math.max(l.max, 1)) }];
    });
  const setQty: Ctx['setQty'] = (id, qty) => setLines((cur) => cur.map((x) => (x.skuId === id ? { ...x, quantity: Math.max(1, Math.min(qty, Math.max(x.max, 1))) } : x)));
  const remove: Ctx['remove'] = (id) => setLines((cur) => cur.filter((x) => x.skuId !== id));
  const clear = () => setLines([]);
  return <CartCtx.Provider value={{ lines, count: lines.reduce((a, l) => a + l.quantity, 0), add, setQty, remove, clear }}>{children}</CartCtx.Provider>;
}
