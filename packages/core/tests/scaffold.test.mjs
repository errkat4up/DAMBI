import assert from "node:assert/strict";
import test from "node:test";
import { CoreError, createCore } from "@dambi/core";

test("built public entry rejects asynchronously with the scaffold error", async () => {
  const pending = createCore({});
  assert.ok(pending instanceof Promise, "createCore must return a Promise instead of throwing synchronously");
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof CoreError);
    assert.equal(error.code, "NOT_IMPLEMENTED");
    return true;
  });
});

test("built internal package entry resolves under Node ESM", async () => {
  await import("@dambi/core/internal");
});
