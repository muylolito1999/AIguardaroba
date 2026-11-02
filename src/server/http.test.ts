import { redirect } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { SESSION_COOKIE, signSessionToken } from "@/lib/auth/token";
import { AppError, err, ok } from "@/lib/result";

import { authedAction } from "./actions/_wrap";
import { authedRoute, type AuthedRouteContext } from "./http";

// The real DAL and token code run; only the request cookie store is faked.
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
  }),
}));

const SECRET = "test-session-secret-0123456789abcdef";
const ORIGIN = "http://localhost:3000";
const NO_PARAMS = { params: Promise.resolve({}) };

beforeEach(async () => {
  vi.stubEnv("SESSION_SECRET", SECRET);
  jar.clear();
  jar.set(SESSION_COOKIE, await signSessionToken(SECRET));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function signOut() {
  jar.clear();
}

function post(body: unknown, headers: Record<string, string> = { origin: ORIGIN }, path = "/api/items"): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const schema = z.object({ name: z.string().min(1), count: z.number().int().positive() });

describe("authedRoute", () => {
  it("validates, calls the handler with the session and returns { ok, data }", async () => {
    const handler = vi.fn(async (input: z.output<typeof schema>) => ok({ echoed: input.name }));
    const route = authedRoute(schema, handler);

    const response = await route(post({ name: "coat", count: 2 }), NO_PARAMS);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { echoed: "coat" } });
    expect(handler).toHaveBeenCalledWith(
      { name: "coat", count: 2 },
      expect.objectContaining({ session: expect.objectContaining({ sub: "owner" }) }),
    );
  });

  it("refuses a mutating request from another origin with 403 before anything else", async () => {
    const handler = vi.fn(async () => ok(null));
    const route = authedRoute(schema, handler);

    const response = await route(post({ name: "coat", count: 1 }, { origin: "https://evil.example" }), NO_PARAMS);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, error: { message: "Cross-origin requests are not allowed." } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a mutating request with no Origin or an opaque one", async () => {
    const route = authedRoute(schema, async () => ok(null));
    expect((await route(post({ name: "coat", count: 1 }, {}), NO_PARAMS)).status).toBe(403);
    expect((await route(post({ name: "coat", count: 1 }, { origin: "null" }), NO_PARAMS)).status).toBe(403);
  });

  it("compares the Origin with x-forwarded-host when a proxy sets it", async () => {
    const route = authedRoute(schema, async () => ok("fine"));
    const headers = { origin: "https://wardrobe.example", "x-forwarded-host": "wardrobe.example" };
    expect((await route(post({ name: "coat", count: 1 }, headers), NO_PARAMS)).status).toBe(200);
  });

  it("returns 401 UNAUTHENTICATED without a session", async () => {
    signOut();
    const handler = vi.fn(async () => ok(null));
    const response = await authedRoute(schema, handler)(post({ name: "coat", count: 1 }), NO_PARAMS);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 401 for a session signed with another secret", async () => {
    jar.set(SESSION_COOKIE, await signSessionToken("an-attacker-secret-0123456789abcdef"));
    expect((await authedRoute(schema, async () => ok(null))(post({ name: "coat", count: 1 }), NO_PARAMS)).status).toBe(401);
  });

  it("returns 400 VALIDATION with the failing fields", async () => {
    const handler = vi.fn(async () => ok(null));
    const response = await authedRoute(schema, handler)(post({ name: "", count: -1 }), NO_PARAMS);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; details: { issues: Array<{ path: string }> } } };
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.details.issues.map((issue) => issue.path).sort()).toEqual(["count", "name"]);
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 400 for a body that is not JSON", async () => {
    const response = await authedRoute(schema, async () => ok(null))(post("{not json"), NO_PARAMS);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "VALIDATION", message: "The request body must be JSON." } });
  });

  it("maps a returned Err to its HTTP status, with Retry-After for RATE_LIMITED", async () => {
    const notFound = authedRoute(schema, async () => err("NOT_FOUND", "No such item"));
    const missing = await notFound(post({ name: "coat", count: 1 }), NO_PARAMS);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ ok: false, error: { code: "NOT_FOUND", message: "No such item" } });

    const limited = authedRoute(schema, async () => err("RATE_LIMITED", "Slow down", { retryAfterSeconds: 90 }));
    const response = await limited(post({ name: "coat", count: 1 }), NO_PARAMS);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("90");
  });

  it("hides an unexpected error as 500 INTERNAL and logs the original", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const route = authedRoute(schema, async () => {
      throw new Error('relation "secret_table" does not exist at postgres://user:hunter2@db');
    });

    const response = await route(post({ name: "coat", count: 1 }), NO_PARAMS);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      ok: false,
      error: { code: "INTERNAL", message: "Something went wrong. Please try again." },
    });
    expect(text).not.toContain("secret_table");
    expect(text).not.toContain("hunter2");
    expect(error).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0]?.[0])).toContain("POST /api/items");
    expect(error.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });

  it("hides CONFIG details, thrown or returned, and logs them", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const thrown = authedRoute(schema, async () => {
      throw new AppError("CONFIG", "Invalid server configuration (db): DATABASE_URL is not set.");
    });
    const returned = authedRoute(schema, async () => err("CONFIG", "BLOB_READ_WRITE_TOKEN is not set"));

    for (const route of [thrown, returned]) {
      const response = await route(post({ name: "coat", count: 1 }), NO_PARAMS);
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({
        ok: false,
        error: { code: "CONFIG", message: "The server is misconfigured. Check the server logs." },
      });
      expect(text).not.toMatch(/DATABASE_URL|BLOB_READ_WRITE_TOKEN/);
    }
    expect(error).toHaveBeenCalledTimes(2);
  });

  it("does not log expected AppErrors", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const route = authedRoute(schema, async () => {
      throw new AppError("CONFLICT", "Changed elsewhere");
    });
    expect((await route(post({ name: "coat", count: 1 }), NO_PARAMS)).status).toBe(409);
    expect(error).not.toHaveBeenCalled();
  });

  it("parses GET input from the query string and needs no Origin", async () => {
    const query = z.object({ part: z.coerce.number().int().min(1), tag: z.array(z.string()).optional() });
    const route = authedRoute(query, async (input) => ok(input));
    const response = await route(new Request(`${ORIGIN}/api/export?part=2&tag=a&tag=b`), NO_PARAMS);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { part: 2, tag: ["a", "b"] } });
  });

  it("passes a returned Response through and hands typed params to the handler", async () => {
    const route = authedRoute(null, async (_input, { params }: AuthedRouteContext<{ id: string }>) => {
      const { id } = await params;
      return new Response(`file for ${id}`, { headers: { "content-type": "text/plain" } });
    });
    const response = await route(new Request(`${ORIGIN}/api/items/abc/export`), { params: Promise.resolve({ id: "abc" }) });
    expect(await response.text()).toBe("file for abc");
  });

  it("lets redirect() inside a handler reach Next", async () => {
    const route = authedRoute(null, async () => redirect("/wardrobe"));
    await expect(route(new Request(`${ORIGIN}/api/x`), NO_PARAMS)).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });
  });
});

describe("authedAction", () => {
  const action = authedAction(schema, async (input, { session }) => ok(`${session.sub}:${input.name}x${input.count}`), {
    name: "test",
  });

  it("checks the session, validates and returns the Result", async () => {
    expect(await action({ name: "coat", count: 3 })).toEqual({ ok: true, data: "owner:coatx3" });
  });

  it("returns UNAUTHENTICATED without a session", async () => {
    signOut();
    expect(await action({ name: "coat", count: 3 })).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
  });

  it("returns VALIDATION for bad input", async () => {
    const result = await action({ name: "", count: 0 } as never);
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });

  it("reads a FormData argument as a plain object", async () => {
    const formAction = authedAction(
      z.object({ name: z.string(), sizes: z.array(z.string()) }),
      async (input) => ok(input),
    );
    const formData = new FormData();
    formData.set("name", "coat");
    formData.append("sizes", "M");
    formData.append("sizes", "L");
    expect(await formAction(formData)).toEqual({ ok: true, data: { name: "coat", sizes: ["M", "L"] } });
  });

  it("hides and logs unexpected errors", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = authedAction(schema, async () => {
      throw new Error("connection to secret-host refused");
    });
    const result = await failing({ name: "coat", count: 1 });
    expect(result).toEqual({ ok: false, error: { code: "INTERNAL", message: "Something went wrong. Please try again." } });
    expect(JSON.stringify(result)).not.toContain("secret-host");
    expect(error).toHaveBeenCalledOnce();
  });

  it("hides CONFIG details from a thrown error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = authedAction(schema, async () => {
      throw new AppError("CONFIG", "ANTHROPIC_API_KEY is not set");
    });
    expect(JSON.stringify(await failing({ name: "coat", count: 1 }))).not.toContain("ANTHROPIC_API_KEY");
  });

  it("lets redirect() reach Next", async () => {
    const redirecting = authedAction(schema, async () => redirect("/wardrobe"));
    await expect(redirecting({ name: "coat", count: 1 })).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });
  });
});
