/**
 * Cheap token estimation (chars/4 heuristic — within ~15% on English/code
 * mixes, always on the safe side when paired with the safety buffer) and
 * greedy budget packing for retrieval responses.
 */

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface Budgetable {
  text: string;
}

/**
 * Greedy-pack items (already ranked best-first) under a token budget.
 * Guarantees at least `minItems` (truncating their text if necessary) so a
 * response is never empty just because the top hit is huge.
 */
export function packUnderBudget<T extends Budgetable>(
  items: T[],
  budgetTokens: number,
  minItems: number,
  maxItems: number
): T[] {
  const out: T[] = [];
  let used = 0;
  for (const item of items) {
    if (out.length >= maxItems) break;
    const cost = estimateTokens(item.text);
    if (used + cost <= budgetTokens) {
      out.push(item);
      used += cost;
    } else if (out.length < minItems) {
      const remaining = Math.max(budgetTokens - used, 200);
      const clipped = { ...item, text: item.text.slice(0, remaining * 4) + "\n…[truncated to fit token budget]" };
      out.push(clipped);
      used = budgetTokens;
    }
  }
  return out;
}
