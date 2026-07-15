import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const probe = fileURLToPath(
  new URL("../apps/site/src/__astro_typecheck_probe__.astro", import.meta.url),
);
const npmCommand = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
const npmArguments = process.platform === "win32"
  ? ["/d", "/s", "/c", "npm.cmd run typecheck --workspace @wisdom/site"]
  : ["run", "typecheck", "--workspace", "@wisdom/site"];

test("site typecheck rejects an invalid Astro component", () => {
  writeFileSync(
    probe,
    [
      "---",
      'const message: string = 42;',
      "---",
      "<p>{message}</p>",
      "",
    ].join("\n"),
    "utf8",
  );

  try {
    const result = spawnSync(
      npmCommand,
      npmArguments,
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, CI: "true", NO_COLOR: "1" },
        timeout: 60_000,
      },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error ?? ""}`;

    assert.notEqual(result.status, 0, "invalid .astro source must fail typecheck");
    assert.match(output, /Type 'number' is not assignable to type 'string'/);
    assert.match(output, /__astro_typecheck_probe__\.astro/);
  } finally {
    rmSync(probe, { force: true });
  }
});
