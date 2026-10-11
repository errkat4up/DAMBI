import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import canonicalize from "canonicalize";
import { buildDecoderSnapshot, collectSelectedBundles } from "../build-decoder-snapshot.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtures = join(repo, "fixtures/sdk/pool-materialization");
const digest = (text: string) => `0x${createHash("sha256").update(text, "utf8").digest("hex")}`;
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "dambi-pool-inputs-"));
  for (const name of ["templates", "contexts", "selection.json"]) {
    cpSync(join(fixtures, name), join(root, name), { recursive: true });
  }
  return { root, selectionFile: join(root, "selection.json"), outRoot: join(root, "output") };
}

test("selected snapshots install reproducibly and a rejected candidate preserves the saved pair and product snapshot", async () => {
  const ws = workspace();
  const product = join(repo, "packages/core/decoder-snapshots/full");
  const productBefore = ["snapshot.json", "snapshot.meta.json"].map((file) => readFileSync(join(product, file), "utf8"));
  try {
    const first = await buildDecoderSnapshot(ws);
    // Selection order and context object-key order must not affect canonical bytes.
    const selection = read(ws.selectionFile);
    selection.entries.reverse();
    write(ws.selectionFile, selection);
    const contextPath = join(ws.root, "contexts/curve.json");
    const context = read(contextPath);
    context.context = Object.fromEntries(Object.entries(context.context).reverse());
    write(contextPath, context);
    const second = await buildDecoderSnapshot(ws);
    assert.equal(first.artifact, second.artifact);
    assert.deepEqual(first.meta, second.meta);
    assert.equal(first.meta.bundle_count, 3);
    assert.equal(first.meta.selection?.route_count, 3);
    assert.equal(first.meta.digest, digest(first.artifact));
    assert.equal(first.meta.bytes, Buffer.byteLength(first.artifact));
    assert.deepEqual(first.meta.rejected_by_core, []);
    const bundles = JSON.parse(first.artifact).bundles;
    assert.deepEqual(bundles.map((bundle: { id: string }) => bundle.id), first.meta.selection?.inputs.map(({ id }) => id));
    for (const input of first.meta.selection!.inputs) {
      const bundle = bundles.find((value: { id: string }) => value.id === input.id);
      assert.equal(input.bundle_sha256, digest(canonicalize(bundle)!));
    }
    const savedPair = first.written.map((path) => readFileSync(path, "utf8"));
    const templatePath = join(ws.root, "templates/curve.json");
    const template = read(templatePath);
    // Valid source context, invalid selector/ABI agreement: only the real Core gate rejects it.
    template.match.selector = "0x00000001";
    write(templatePath, template);
    await assert.rejects(buildDecoderSnapshot(ws), (error: unknown) => {
      assert.equal((error as { code: string }).code, "INVALID_DECODER_SNAPSHOT");
      return true;
    });
    assert.deepEqual(first.written.map((path) => readFileSync(path, "utf8")), savedPair);
    assert.deepEqual(["snapshot.json", "snapshot.meta.json"].map((file) => readFileSync(join(product, file), "utf8")), productBefore);
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});

test("selection rejects duplicate ids, conflicting routes and missing or escaping inputs without fallback", async () => {
  const ws = workspace();
  try {
    const selection = read(ws.selectionFile);
    const first = selection.entries[0];
    write(ws.selectionFile, { ...selection, entries: [first, first] });
    await assert.rejects(collectSelectedBundles(ws.selectionFile), /duplicate selected bundle id/);

    const context = read(join(ws.root, first.context));
    context.context.id_suffix += "-other-id";
    write(join(ws.root, "contexts/conflict.json"), context);
    write(ws.selectionFile, { ...selection, entries: [first, { ...first, context: "contexts/conflict.json" }] });
    await assert.rejects(collectSelectedBundles(ws.selectionFile), /conflicting selected route/);

    for (const path of ["contexts/missing.json", "../outside.json"]) {
      write(ws.selectionFile, { ...selection, entries: [{ ...first, context: path }] });
      await assert.rejects(collectSelectedBundles(ws.selectionFile), /ENOENT|normalized relative JSON path/);
    }
    symlinkSync(join(fixtures, first.context), join(ws.root, "contexts/escaped.json"));
    write(ws.selectionFile, { ...selection, entries: [{ ...first, context: "contexts/escaped.json" }] });
    await assert.rejects(collectSelectedBundles(ws.selectionFile), /escapes its directory/);
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
});

test("regression selection cannot bypass Core verification or overwrite the packaged snapshot", async () => {
  const selectionFile = join(fixtures, "selection.json");
  await assert.rejects(buildDecoderSnapshot({ selectionFile, verify: false }), /requires the Core gate/);
  await assert.rejects(buildDecoderSnapshot({ selectionFile, addManifests: ["unused.json"] }), /cannot be combined/);
  await assert.rejects(buildDecoderSnapshot({ selectionFile, name: "full", outRoot: join(repo, "packages/core/decoder-snapshots") }), /cannot write a packaged/);
});
