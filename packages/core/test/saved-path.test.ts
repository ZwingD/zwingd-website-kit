/**
 * The saved-path rule against the contract's own fixtures (session hand-over
 * v1, "The saved path"): every `accepted` value unchanged, every `refused`
 * value replaced by `/`, 512 characters accepted and 513 refused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { SAVED_PATH_MAX, savedPath } from "../src/saved-path.ts";

const fixtures = JSON.parse(readFileSync(new URL("../fixtures/saved-path.json", import.meta.url), "utf8")) as {
  source: string;
  accepted: string[];
  refused: string[];
};

test("the fixtures file names its source", () => {
  assert.match(fixtures.source, /session-handover-v1\.md/);
  assert.equal(fixtures.accepted.length, 8);
  assert.equal(fixtures.refused.length, 20);
});

for (const value of fixtures.accepted) {
  test(`accepted unchanged: ${JSON.stringify(value)}`, () => {
    assert.equal(savedPath(value), value);
  });
}

for (const value of fixtures.refused) {
  test(`refused to "/": ${JSON.stringify(value)}`, () => {
    assert.equal(savedPath(value), "/");
  });
}

test("a path of exactly 512 characters is accepted, 513 is refused", () => {
  const at = "/" + "a".repeat(SAVED_PATH_MAX - 1);
  assert.equal(at.length, 512);
  assert.equal(savedPath(at), at);
  assert.equal(savedPath(at + "a"), "/");
});

// The fixtures are a copy of the contract's. When a zwingd-backend checkout sits
// beside this repo, its doc must hold exactly these values (else skipped, visibly).
const contractDoc = new URL("../../../../zwingd-backend/docs/storefront-api/session-handover-v1.md", import.meta.url);
const doc = existsSync(contractDoc) ? readFileSync(contractDoc, "utf8") : null;
test("the fixtures equal the contract doc's", { skip: doc === null ? "no zwingd-backend checkout beside this repo" : false }, () => {
  const block = /<!-- fixtures:saved-path -->\s*```json\s*([\s\S]*?)```/.exec(doc ?? "");
  assert.ok(block, "the doc holds a saved-path fixtures block");
  const fromDoc = JSON.parse(block![1]!) as { accepted: string[]; refused: string[] };
  assert.deepEqual({ accepted: fixtures.accepted, refused: fixtures.refused }, fromDoc);
});

test("a missing or non-string value becomes /", () => {
  for (const value of [undefined, null, 42, ["/x"], { p: "/x" }]) assert.equal(savedPath(value), "/");
});
