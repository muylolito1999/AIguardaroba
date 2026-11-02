import { describe, expect, it } from "vitest";

import { APP_ENV_VARS } from "./app-env-vars";

describe("APP_ENV_VARS", () => {
  it("are all blank inside unit tests (vitest.config.mts)", () => {
    for (const name of APP_ENV_VARS) expect(process.env[name], name).toBe("");
  });
});
