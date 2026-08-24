import assert from "node:assert/strict";
import test from "node:test";
import { clampPlayerPosition, isVideoControlStrip } from "../lib/v19-player-drag.ts";

test("clampPlayerPosition keeps every player edge inside the viewport (plan-doc case)", () => {
  assert.deepEqual(
    clampPlayerPosition({ x: -40, y: 900 }, { width: 420, height: 236 }, { width: 1280, height: 800 }, 0),
    { x: 0, y: 564 },
  );
});

test("clampPlayerPosition preserves an in-bounds dragged position", () => {
  const inBounds = { x: 240, y: 180 };
  assert.deepEqual(
    clampPlayerPosition(inBounds, { width: 420, height: 236 }, { width: 1280, height: 800 }, 0),
    inBounds,
  );
});

test("isVideoControlStrip reserves the bottom video controls (plan-doc case)", () => {
  assert.equal(isVideoControlStrip(210, 240, 44), true);
  assert.equal(isVideoControlStrip(190, 240, 44), false);
});

test("clampPlayerPosition clamps a position past the left or top edge to the margin", () => {
  assert.deepEqual(
    clampPlayerPosition({ x: -500, y: -500 }, { width: 420, height: 236 }, { width: 1280, height: 800 }, 8),
    { x: 8, y: 8 },
  );
});

test("clampPlayerPosition clamps a position past the right or bottom edge", () => {
  assert.deepEqual(
    clampPlayerPosition({ x: 5000, y: 5000 }, { width: 420, height: 236 }, { width: 1280, height: 800 }, 8),
    { x: 1280 - 420 - 8, y: 800 - 236 - 8 },
  );
});

test("clampPlayerPosition never produces a negative position when the viewport is smaller than the player", () => {
  const result = clampPlayerPosition({ x: 40, y: 40 }, { width: 420, height: 236 }, { width: 300, height: 150 }, 8);
  assert.deepEqual(result, { x: 8, y: 8 });
  assert(result.x >= 0 && result.y >= 0, "clamped position must never go negative");
});

test("clampPlayerPosition defaults margin to 8 when omitted", () => {
  assert.deepEqual(
    clampPlayerPosition({ x: -40, y: -40 }, { width: 420, height: 236 }, { width: 1280, height: 800 }),
    { x: 8, y: 8 },
  );
  assert.deepEqual(
    clampPlayerPosition({ x: 5000, y: 5000 }, { width: 420, height: 236 }, { width: 1280, height: 800 }),
    { x: 1280 - 420 - 8, y: 800 - 236 - 8 },
  );
});

test("isVideoControlStrip defaults stripHeight to 34 when omitted", () => {
  assert.equal(isVideoControlStrip(210, 240), true);
  assert.equal(isVideoControlStrip(200, 240), false);
});
