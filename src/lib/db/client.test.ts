import { afterEach, describe, expect, it, vi } from "vitest";

import { createDb } from "./client";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createDb", () => {
  it("survives an idle client error instead of crashing the process", async () => {
    // Nothing connects until the first query, so the address is never dialled.
    const { pool } = createDb("postgres://user:fake-password@127.0.0.1:1/none");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(pool.listenerCount("error")).toBeGreaterThan(0);
      // EventEmitter throws an 'error' event that has no listener.
      expect(() => pool.emit("error", new Error("terminating connection due to administrator command"))).not.toThrow();
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0]?.[0])).toContain("[db]");
    } finally {
      await pool.end();
    }
  });

  it("bounds connection waits and keeps the pool small", async () => {
    const { pool } = createDb("postgres://user:fake-password@127.0.0.1:1/none");
    try {
      expect(pool.options).toMatchObject({ max: 3, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 });
    } finally {
      await pool.end();
    }
  });
});
