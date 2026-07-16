import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgeAdapter } from "../lib/system-adapters.mjs";

test("age decrypt passes identity through a protected file, never a process argument", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisdom-age-adapter-"));
  const input = path.join(directory, "backup.age");
  const output = path.join(directory, "restored.sqlite");
  const calls = [];
  await writeFile(input, "ciphertext");
  const adapter = createAgeAdapter({
    executable: path.join(path.parse(process.cwd()).root, "opt", "bin", "age"),
    run: async (executable, args, options) => {
      calls.push({ executable, args, options });
      const identityPath = args[args.indexOf("--identity") + 1];
      assert.equal(await readFile(identityPath, "utf8"), "AGE-SECRET-KEY-OPERATOR\n");
      await writeFile(output, "plaintext-snapshot");
    },
  });

  await adapter.decrypt({
    input,
    output,
    identity: "AGE-SECRET-KEY-OPERATOR",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.shell, false);
  assert.doesNotMatch(JSON.stringify(calls[0].args), /AGE-SECRET-KEY-OPERATOR/);
  const identityPath = calls[0].args[calls[0].args.indexOf("--identity") + 1];
  await assert.rejects(readFile(identityPath), { code: "ENOENT" });
});

test("age encryption accepts only an age recipient and absolute paths", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisdom-age-encrypt-"));
  const input = path.join(directory, "snapshot.sqlite");
  const output = path.join(directory, "snapshot.age");
  const calls = [];
  await writeFile(input, "snapshot");
  const adapter = createAgeAdapter({
    executable: path.join(path.parse(process.cwd()).root, "opt", "bin", "age"),
    run: async (_executable, args, options) => {
      calls.push({ args, options });
      await writeFile(output, "ciphertext");
    },
  });

  await adapter.encrypt({ input, output, recipient: "age1fixtureoperator" });
  assert.deepEqual(calls[0].args, ["--recipient", "age1fixtureoperator", "--output", output, input]);
  assert.equal(calls[0].options.shell, false);
  await assert.rejects(
    adapter.encrypt({ input: "snapshot.sqlite", output, recipient: "not-an-age-recipient" }),
    { code: "AGE_ADAPTER_INPUT_INVALID" },
  );
});
