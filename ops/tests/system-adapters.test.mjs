import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgeAdapter } from "../lib/system-adapters.mjs";

test("age decrypt streams identity through stdin, never a file or process argument", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisdom-age-adapter-"));
  const input = path.join(directory, "backup.age");
  const output = path.join(directory, "restored.sqlite");
  const calls = [];
  let identityBuffer;
  await writeFile(input, "ciphertext");
  const adapter = createAgeAdapter({
    executable: path.join(path.parse(process.cwd()).root, "opt", "bin", "age"),
    run: async (executable, args, options) => {
      calls.push({ executable, args, options });
      identityBuffer = options.stdin;
      assert.equal(Buffer.from(identityBuffer).toString("utf8"), "AGE-SECRET-KEY-OPERATOR\n");
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
  assert.deepEqual(calls[0].options.stdio, ["pipe", "ignore", "ignore"]);
  assert.deepEqual(calls[0].args, ["--decrypt", "--identity", "-", "--output", output, input]);
  assert.doesNotMatch(JSON.stringify(calls[0].args), /AGE-SECRET-KEY-OPERATOR/);
  assert.ok(Buffer.from(identityBuffer).every((byte) => byte === 0));
  assert.deepEqual((await readdir(directory)).sort(), ["backup.age", "restored.sqlite"]);
});

test("age decrypt fails closed when a legacy identity residue exists in the output directory", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisdom-age-residue-"));
  const input = path.join(directory, "backup.age");
  const output = path.join(directory, "restored.sqlite");
  const residue = path.join(directory, "previous.sqlite.identity-abandoned");
  let calls = 0;
  await writeFile(input, "ciphertext");
  await writeFile(residue, "AGE-SECRET-KEY-RESIDUE");
  const adapter = createAgeAdapter({
    executable: path.join(path.parse(process.cwd()).root, "opt", "bin", "age"),
    run: async () => { calls += 1; },
  });

  await assert.rejects(adapter.decrypt({
    input,
    output,
    identity: "AGE-SECRET-KEY-OPERATOR",
  }), { code: "AGE_IDENTITY_RESIDUE_DETECTED" });
  assert.equal(calls, 0);
  assert.equal(await readFile(residue, "utf8"), "AGE-SECRET-KEY-RESIDUE");
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
