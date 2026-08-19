import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  V04_CONTRACT_STATUS,
  V04_DERIVED_CAPABILITY_KEYS,
  V04_EXPLICIT_ROLE_KEYS,
  V04_PAYLOAD_SCHEMA_VERSION,
  V04_SHOT_FIELD_KEYS,
  V04_TAXONOMY_VERSION,
  V04_VERSION_CONTRACT,
  V04_VOCABULARY_VERSION,
  V04_WORKFLOW_VERSION,
} from "../lib/v04-contract.ts";
import {
  serializeV04VocabularyTsv,
  V04_VOCABULARY_APPROVED_HASHES,
  V04_VOCABULARY_FIELD_ORDER,
  V04_VOCABULARY_OPTIONS,
} from "../lib/v04-vocabulary.ts";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

test("V0.4 version contract stays isolated and draft in batch 1A", () => {
  assert.equal(V04_TAXONOMY_VERSION, "AD_VIDEO_TAXONOMY_V1");
  assert.equal(V04_WORKFLOW_VERSION, "AD_VIDEO_WORKFLOW_V1");
  assert.equal(V04_VOCABULARY_VERSION, "AD_VIDEO_VOCAB_V1");
  assert.equal(V04_PAYLOAD_SCHEMA_VERSION, "AD_VIDEO_PAYLOAD_V1");
  assert.equal(V04_CONTRACT_STATUS, "DRAFT");
  assert.equal(V04_VERSION_CONTRACT.status, "DRAFT");
  assert.deepEqual(V04_EXPLICIT_ROLE_KEYS, ["EXPERT", "SYSTEM_ADMIN"]);
  assert.deepEqual(V04_DERIVED_CAPABILITY_KEYS, ["MEMBER", "UPLOADER"]);
});

test("V0.4 shot contract has the approved twelve independent fields", () => {
  assert.deepEqual(V04_SHOT_FIELD_KEYS, [
    "startTime",
    "endTime",
    "shotScale",
    "cameraAngle",
    "cameraMovement",
    "visualContent",
    "screenCopy",
    "subtitleEffect",
    "dialogue",
    "voiceOver",
    "soundEffect",
    "music",
  ]);
});

test("approved 24/15/21 vocabulary TSV is byte stable", () => {
  const expectedCounts = new Map([
    ["bridgeCreativeRole", 24],
    ["generalMechanism", 15],
    ["storyReferenceType", 21],
  ]);
  assert.equal(V04_VOCABULARY_OPTIONS.length, 60);
  assert.equal(new Set(V04_VOCABULARY_OPTIONS.map((option) => option.optionId)).size, 60);

  for (const fieldKey of V04_VOCABULARY_FIELD_ORDER) {
    const options = V04_VOCABULARY_OPTIONS.filter((option) => option.fieldKey === fieldKey);
    assert.equal(options.length, expectedCounts.get(fieldKey));
    assert.deepEqual(options.map((option) => option.orderIndex),
      Array.from({ length: options.length }, (_, index) => index + 1));
    const tsv = serializeV04VocabularyTsv(options);
    assert.equal(sha256(tsv), V04_VOCABULARY_APPROVED_HASHES[fieldKey]);
  }

  assert.equal(sha256(serializeV04VocabularyTsv()), V04_VOCABULARY_APPROVED_HASHES.combined);
  assert(V04_VOCABULARY_OPTIONS.every((option) => !option.labelZhCn.includes("其他")));
});
