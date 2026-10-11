import { describe, expect, it } from "vitest";
import { estimateTokens, packUnderBudget } from "../src/tokens.js";

describe("token budget packing", () => {
  const item = (n: number) => ({ text: "a".repeat(n * 4) }); // n estimated tokens

  it("estimates ~chars/4", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("packs best-first until the budget is exhausted", () => {
    const items = [item(500), item(400), item(300), item(200)];
    const packed = packUnderBudget(items, 1000, 1, 10);
    expect(packed).toHaveLength(2); // 500 + 400 fit; 300 doesn't
  });

  it("respects maxItems", () => {
    const packed = packUnderBudget([item(1), item(1), item(1)], 1000, 1, 2);
    expect(packed).toHaveLength(2);
  });

  it("guarantees minItems by truncating an oversized head item", () => {
    const packed = packUnderBudget([item(50_000)], 1000, 1, 10);
    expect(packed).toHaveLength(1);
    expect(packed[0].text).toContain("[truncated to fit token budget]");
    expect(estimateTokens(packed[0].text)).toBeLessThan(1200);
  });
});
