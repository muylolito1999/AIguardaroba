import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearSessionCookie, readSessionCookie, setSessionCookie } from "./session";
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from "./token";

// Only the request cookie store is faked; the options session.ts passes are
// what Next writes into Set-Cookie.
const store = vi.hoisted(() => ({
  set: vi.fn<(name: string, value: string, options: Record<string, unknown>) => void>(),
  values: new Map<string, string>(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    set: store.set,
    get: (name: string) => (store.values.has(name) ? { name, value: store.values.get(name) } : undefined),
  }),
}));

beforeEach(() => {
  store.set.mockReset();
  store.values.clear();
});

describe("session cookie", () => {
  it("uses the __Host- prefix", () => {
    expect(SESSION_COOKIE).toBe("__Host-wardrobe_session");
  });

  it("is set with the attributes the __Host- prefix requires", async () => {
    await setSessionCookie("token-value");
    expect(store.set).toHaveBeenCalledTimes(1);
    const [name, value, options] = store.set.mock.calls[0] ?? [];
    expect(name).toBe(SESSION_COOKIE);
    expect(value).toBe("token-value");
    expect(options).toEqual({ httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_TTL_SECONDS });
    // A Domain attribute would make browsers reject a __Host- cookie.
    expect(options).not.toHaveProperty("domain");
  });

  it("is cleared with the same attributes and maxAge 0", async () => {
    await clearSessionCookie();
    expect(store.set).toHaveBeenCalledWith(SESSION_COOKIE, "", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
  });

  it("is read by its prefixed name", async () => {
    store.values.set("wardrobe_session", "old-unprefixed");
    expect(await readSessionCookie()).toBeUndefined();
    store.values.set(SESSION_COOKIE, "current");
    expect(await readSessionCookie()).toBe("current");
  });
});
