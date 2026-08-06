import assert from "node:assert/strict";
import test from "node:test";

import {
  clampPlayerPosition,
  isVideoControlStrip,
} from "../app/components/DraggableVideoPlayer.tsx";

test("clampPlayerPosition keeps every player edge inside the viewport", () => {
  assert.deepEqual(
    clampPlayerPosition(
      { x: -40, y: 900 },
      { width: 420, height: 236 },
      { width: 1280, height: 800 },
    ),
    { x: 0, y: 564 },
  );
});

test("clampPlayerPosition preserves an in-bounds dragged position", () => {
  assert.deepEqual(
    clampPlayerPosition(
      { x: 240, y: 180 },
      { width: 420, height: 236 },
      { width: 1280, height: 800 },
    ),
    { x: 240, y: 180 },
  );
});

test("clampPlayerPosition returns a player to view after a viewport resize", () => {
  assert.deepEqual(
    clampPlayerPosition(
      { x: 860, y: 540 },
      { width: 420, height: 236 },
      { width: 900, height: 600 },
    ),
    { x: 480, y: 364 },
  );
});

test("isVideoControlStrip reserves the bottom native video controls", () => {
  assert.equal(isVideoControlStrip(210, 240, 44), true);
  assert.equal(isVideoControlStrip(190, 240, 44), false);
});
