import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("package lock resolves rolldown's exact WASM dependencies", async () => {
  const lock = JSON.parse(
    await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
  );
  const packagePath = "node_modules/@rolldown/binding-wasm32-wasi";
  const dependencies = lock.packages[packagePath].dependencies;

  for (const dependency of ["@emnapi/core", "@emnapi/runtime"]) {
    const nestedPath = `${packagePath}/node_modules/${dependency}`;
    const rootPath = `node_modules/${dependency}`;
    const resolved = lock.packages[nestedPath] ?? lock.packages[rootPath];

    assert.equal(
      resolved?.version,
      dependencies[dependency],
      `${dependency}@${dependencies[dependency]} is missing from package-lock.json`,
    );
  }
});
