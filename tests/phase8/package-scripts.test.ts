import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("package scripts", () => {
  it("exposes kernel npm scripts for the CLI control surface", async () => {
    const packageJsonPath = join(process.cwd(), "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf-8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts).toMatchObject({
      "kernel:start": "tsx bin/openharness.ts start",
      "kernel:status": "tsx bin/openharness.ts status",
      "kernel:watch": "tsx bin/openharness.ts watch",
      "kernel:stop": "tsx bin/openharness.ts stop",
      "kernel:restart": "tsx bin/openharness.ts restart",
    });
  });
});