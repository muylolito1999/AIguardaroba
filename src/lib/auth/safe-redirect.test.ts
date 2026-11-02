import { describe, expect, it } from "vitest";

import { DEFAULT_AFTER_LOGIN, nextFromLoginReferer, safeRedirect } from "./safe-redirect";

describe("safeRedirect", () => {
  it.each([
    ["/wardrobe?category=top", "/wardrobe?category=top"],
    ["/relocate", "/relocate"],
    ["/wardrobe/123e4567-e89b-12d3-a456-426614174000", "/wardrobe/123e4567-e89b-12d3-a456-426614174000"],
    ["/settings#climate", "/settings#climate"],
    // Normalized, but still on our origin.
    ["/wardrobe/../relocate", "/relocate"],
    ["/wardrobe?q=red coat", "/wardrobe?q=red%20coat"],
  ])("accepts %j", (input, expected) => {
    expect(safeRedirect(input)).toBe(expected);
  });

  it.each([
    "//evil.com",
    "//evil.com/wardrobe",
    "https://x",
    "https://evil.com/wardrobe",
    "/\\evil.com",
    "/\\/evil.com",
    "\\\\evil.com",
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,hi",
    "wardrobe",
    " /wardrobe",
    "/\t/evil.com",
    "/\n/evil.com",
    // Dot segments that collapse into "//evil.com" only after normalization.
    "/.//evil.com",
    "/./evil.com/..//evil.com",
    "/a/..//evil.com",
    "/..//evil.com",
    "/%2e//evil.com",
    "/%2E%2E//evil.com",
    "/x/%2e%2e//evil.com",
    "/.//evil.com?next=/wardrobe#top",
    "/wardrobe\u0000",
    "/login",
    "/login?next=/wardrobe",
    "/login/",
    "/api/items",
    "",
    "/".padEnd(3000, "a"),
  ])("rejects %j", (input) => {
    expect(safeRedirect(input)).toBe(DEFAULT_AFTER_LOGIN);
  });

  it.each([undefined, null, 42, ["/wardrobe"], { next: "/wardrobe" }])("falls back for non-string %j", (input) => {
    expect(safeRedirect(input)).toBe("/wardrobe");
  });

  it("keeps an encoded slash as part of the path, not a second authority", () => {
    expect(safeRedirect("/%2F%2Fevil.com")).toBe("/%2F%2Fevil.com");
  });

  it("never returns a value that resolves to another origin", () => {
    const inputs = ["/.//evil.com", "/a/..//evil.com", "/%2e//evil.com", "/wardrobe", "/wardrobe//x", "/x/..//y"];
    for (const input of inputs) {
      const target = safeRedirect(input);
      expect(target.startsWith("//"), `${input} -> ${target}`).toBe(false);
      expect(new URL(target, "https://app.example").origin, input).toBe("https://app.example");
    }
  });
});

describe("nextFromLoginReferer", () => {
  it.each([
    ["http://localhost:3000/login?next=%2Fsettings", "/settings"],
    ["https://wardrobe.example/login?next=%2Fwardrobe%3Fcategory%3Dtop", "/wardrobe?category=top"],
    // Returned raw: safeRedirect decides whether it is usable.
    ["https://wardrobe.example/login?next=%2F%2Fevil.com", "//evil.com"],
  ])("reads next from %j", (referer, expected) => {
    expect(nextFromLoginReferer(referer)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    "",
    "not a url",
    "/login?next=%2Fsettings",
    "https://wardrobe.example/login",
    "https://wardrobe.example/settings?next=%2Frelocate",
    "https://wardrobe.example/login/?next=%2Frelocate",
    `https://wardrobe.example/login?next=${"a".repeat(5000)}`,
  ])("returns undefined for %j", (referer) => {
    expect(nextFromLoginReferer(referer)).toBeUndefined();
  });

  it("feeds safeRedirect, which still rejects a foreign target", () => {
    expect(safeRedirect(nextFromLoginReferer("https://wardrobe.example/login?next=https%3A%2F%2Fevil.com"))).toBe(
      DEFAULT_AFTER_LOGIN,
    );
  });
});
