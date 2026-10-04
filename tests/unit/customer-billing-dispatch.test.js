// Regression: combo/capacity-adapter dispatch must forward customerBilling to
// handleSingleModelChat. When dropped, settle never runs — the reserve_hold
// strands (Reserved grows, balance never debited) even though usage is logged.
// The dispatch code is a thin wiring layer, so this test asserts the wiring
// statically: every handleSingleModelChat call passes customerBilling as its
// 7th argument.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const chatSrc = fs.readFileSync(
  path.join(process.cwd(), "..", "src", "sse", "handlers", "chat.js"),
  "utf8",
);

// Extract balanced-paren argument lists for every `handleSingleModelChat(`
// call site (skips the `function` definition itself).
function callArgs(src, name) {
  const out = [];
  let i = src.indexOf(name);
  while (i !== -1) {
    const isDef = src.slice(i - 9, i) === "function ";
    const open = src.indexOf("(", i);
    if (open === i + name.length) {
      let depth = 0;
      let j = open;
      for (; j < src.length; j++) {
        if (src[j] === "(") depth++;
        else if (src[j] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      if (!isDef) out.push(src.slice(open + 1, j));
      i = src.indexOf(name, j);
    } else {
      i = src.indexOf(name, i + 1);
    }
  }
  return out;
}

describe("customerBilling dispatch wiring", () => {
  it("every handleSingleModelChat call forwards customerBilling as the 7th arg", () => {
    const calls = callArgs(chatSrc, "handleSingleModelChat");
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      const parts = args.split(",");
      expect(
        parts.length >= 7 && parts[6].includes("customerBilling"),
        `handleSingleModelChat call must forward customerBilling as 7th arg: got (${args.trim()})`,
      ).toBe(true);
    }
  });
});
