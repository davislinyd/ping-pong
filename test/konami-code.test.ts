import { describe, expect, it } from "vitest";

import { KONAMI_SEQUENCE, matchesKonami, normalizeKonamiKey } from "../src/client/konami-code";

describe("konami code helpers", () => {
  it("matches the exact konami sequence", () => {
    expect(matchesKonami([...KONAMI_SEQUENCE])).toBe(true);
  });

  it("matches when the sequence is at the tail of a noisy buffer", () => {
    expect(matchesKonami(["a", "Enter", "x", ...KONAMI_SEQUENCE])).toBe(true);
  });

  it("rejects an incomplete sequence", () => {
    expect(matchesKonami(KONAMI_SEQUENCE.slice(0, -1))).toBe(false);
  });

  it("rejects a wrong sequence of the right length", () => {
    const wrong = [...KONAMI_SEQUENCE];
    wrong[0] = "ArrowDown";
    expect(matchesKonami(wrong)).toBe(false);
  });

  it("normalizes letter keys to lower case and leaves named keys intact", () => {
    expect(normalizeKonamiKey("B")).toBe("b");
    expect(normalizeKonamiKey("A")).toBe("a");
    expect(normalizeKonamiKey("ArrowUp")).toBe("ArrowUp");
  });
});
