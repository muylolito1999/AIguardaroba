import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// D-113: with E2E_TAG=1 and an API key in the shell, the e2e server gets the
// key. A spec that seeds relocation parts, or opens a run's progress page,
// would then run those parts against the real API, so it must check
// SHELL_TAGGING and skip that work. The specs run no unit test, so this reads
// their source.

const E2E = fileURLToPath(new URL("../e2e", import.meta.url));

function specs(): Array<{ name: string; text: string }> {
  return readdirSync(E2E)
    .filter((name) => name.endsWith(".spec.ts"))
    .map((name) => ({ name, text: readFileSync(path.join(E2E, name), "utf8") }));
}

describe("e2e specs that could start a relocation part", () => {
  it("check whether the server has an API key", () => {
    // Seeds or updates parts, or waits for the relocation stop (add.spec.ts waits
    // for a Blob configuration toast and has its own guard).
    const relocating = specs().filter(
      ({ text }) => text.includes("analysisParts") || (text.includes("/relocate") && text.includes("Configuration problem")),
    );
    expect(relocating.map(({ name }) => name).sort()).toEqual(["a11y.spec.ts", "relocate.spec.ts"]);
    for (const { name, text } of relocating) {
      expect(text, name).toMatch(/\bSHELL_TAGGING\b/);
      expect(text, name).toMatch(/\bNEEDS_NO_API_KEY\b/);
    }
  });
});
