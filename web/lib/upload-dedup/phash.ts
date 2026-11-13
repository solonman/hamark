// 感知哈希（纯函数）：输入已经缩小的灰度图，输出 64 位哈希的十六进制。
// 浏览器负责解码与缩图（fingerprint-browser.ts），这里只做算术，所以能在 Node 里测。
// 步骤见 docs/28 3.2：裁黑边／均匀色边 → 取中间 75% → 32×32 → DCT 左上 8×8 → 对中位数二值化。

export type GrayImage = { width: number; height: number; data: Uint8Array | Uint8ClampedArray };
export type Rect = { left: number; top: number; right: number; bottom: number };

/** 四边各让出 12.5%，避开角标水印。 */
const CENTER_MARGIN = 0.125;
/** 32×32 灰度的标准差低于它，就当画面几乎全平（纯黑转场、纯色），不出哈希。 */
const FLAT_STD = 3;
/** 裁边后剩下的不到原图 25%，说明判断错了（整段都很暗），不裁。 */
const MIN_CONTENT_FRACTION = 0.25;

const SIZE = 32;
const LOW = 8;

const COS_TABLE: Float64Array = (() => {
  const table = new Float64Array(LOW * SIZE);
  for (let u = 0; u < LOW; u += 1) {
    for (let x = 0; x < SIZE; x += 1) table[u * SIZE + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * SIZE));
  }
  return table;
})();

function lineStats(image: GrayImage, index: number, horizontal: boolean): { mean: number; std: number } {
  const length = horizontal ? image.width : image.height;
  let sum = 0;
  let sumSq = 0;
  for (let k = 0; k < length; k += 1) {
    const value = horizontal ? image.data[index * image.width + k] : image.data[k * image.width + index];
    sum += value;
    sumSq += value * value;
  }
  const mean = sum / length;
  return { mean, std: Math.sqrt(Math.max(0, sumSq / length - mean * mean)) };
}

function fullRect(width: number, height: number): Rect {
  return { left: 0, top: 0, right: width, bottom: height };
}

function scanEdges(width: number, height: number, isBorder: (index: number, horizontal: boolean) => boolean): Rect {
  let top = 0;
  while (top < height && isBorder(top, true)) top += 1;
  let bottom = height;
  while (bottom > top && isBorder(bottom - 1, true)) bottom -= 1;
  let left = 0;
  while (left < width && isBorder(left, false)) left += 1;
  let right = width;
  while (right > left && isBorder(right - 1, false)) right -= 1;
  const rect = { left, top, right, bottom };
  const area = (right - left) * (bottom - top);
  return area >= width * height * MIN_CONTENT_FRACTION ? rect : fullRect(width, height);
}

/** 一行／列在八成以上的有画面帧里都又暗又均匀，才算黑边。 */
const LETTERBOX_MAJORITY = 0.8;

function isFlatFrame(frame: GrayImage): boolean {
  let sum = 0;
  let sumSq = 0;
  for (const value of frame.data) {
    sum += value;
    sumSq += value * value;
  }
  const mean = sum / frame.data.length;
  return Math.sqrt(Math.max(0, sumSq / frame.data.length - mean * mean)) < 6;
}

/**
 * 视频的黑边：在绝大多数有画面的帧里都又暗又均匀的行／列。
 * 只看一帧会把暗场景当黑边裁掉；要求「每一帧都是」又会被平台加的整屏片头片尾（没有黑边）
 * 一票否决——那正是要认的情况。所以纯色帧不参与投票，其余帧八成以上算数。所有帧尺寸相同。
 */
export function detectLetterbox(frames: readonly GrayImage[]): Rect {
  if (!frames.length) return fullRect(0, 0);
  const { width, height } = frames[0];
  const voters = frames.filter((frame) => !isFlatFrame(frame));
  if (!voters.length) return fullRect(width, height);
  const needed = Math.ceil(voters.length * LETTERBOX_MAJORITY);
  return scanEdges(width, height, (index, horizontal) => {
    let dark = 0;
    for (const frame of voters) {
      const { mean, std } = lineStats(frame, index, horizontal);
      if (mean < 28 && std < 8) dark += 1;
    }
    return dark >= needed;
  });
}

/** 图片的边：与最外一行／列颜色相同、且本身均匀的行／列（白边、黑边、纯色衬底都算）。 */
export function detectUniformBorder(image: GrayImage): Rect {
  const { width, height } = image;
  if (!width || !height) return fullRect(width, height);
  const edge = {
    top: lineStats(image, 0, true).mean,
    bottom: lineStats(image, height - 1, true).mean,
    left: lineStats(image, 0, false).mean,
    right: lineStats(image, width - 1, false).mean,
  };
  return scanEdges(width, height, (index, horizontal) => {
    const { mean, std } = lineStats(image, index, horizontal);
    const reference = horizontal ? (index < height / 2 ? edge.top : edge.bottom) : index < width / 2 ? edge.left : edge.right;
    return std < 6 && Math.abs(mean - reference) < 12;
  });
}

export function centerRegion(rect: Rect, margin = CENTER_MARGIN): Rect {
  const w = rect.right - rect.left;
  const h = rect.bottom - rect.top;
  return {
    left: rect.left + w * margin,
    top: rect.top + h * margin,
    right: rect.right - w * margin,
    bottom: rect.bottom - h * margin,
  };
}

/** 把 rect 区域按面积平均缩成 32×32（rect 可以是小数坐标）。 */
export function resampleTo32(image: GrayImage, rect: Rect): Float64Array {
  const out = new Float64Array(SIZE * SIZE);
  const cellW = (rect.right - rect.left) / SIZE;
  const cellH = (rect.bottom - rect.top) / SIZE;
  for (let gy = 0; gy < SIZE; gy += 1) {
    const y0 = rect.top + gy * cellH;
    const y1 = y0 + cellH;
    for (let gx = 0; gx < SIZE; gx += 1) {
      const x0 = rect.left + gx * cellW;
      const x1 = x0 + cellW;
      let sum = 0;
      let weight = 0;
      for (let py = Math.floor(y0); py < Math.ceil(y1) && py < image.height; py += 1) {
        const wy = Math.min(y1, py + 1) - Math.max(y0, py);
        if (wy <= 0) continue;
        for (let px = Math.floor(x0); px < Math.ceil(x1) && px < image.width; px += 1) {
          const wx = Math.min(x1, px + 1) - Math.max(x0, px);
          if (wx <= 0) continue;
          sum += image.data[py * image.width + px] * wx * wy;
          weight += wx * wy;
        }
      }
      out[gy * SIZE + gx] = weight ? sum / weight : 0;
    }
  }
  return out;
}

export function mirror32(grid: Float64Array): Float64Array {
  const out = new Float64Array(grid.length);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) out[y * SIZE + x] = grid[y * SIZE + (SIZE - 1 - x)];
  }
  return out;
}

/** 32×32 → 64 位感知哈希；画面几乎全平时返回 null。 */
export function dctHash(grid: Float64Array): string | null {
  let sum = 0;
  let sumSq = 0;
  for (const value of grid) {
    sum += value;
    sumSq += value * value;
  }
  const mean = sum / grid.length;
  if (Math.sqrt(Math.max(0, sumSq / grid.length - mean * mean)) < FLAT_STD) return null;

  // 先按行做到 8 个频率，再按列：只算需要的左上 8×8。
  const rows = new Float64Array(SIZE * LOW);
  for (let y = 0; y < SIZE; y += 1) {
    for (let u = 0; u < LOW; u += 1) {
      let acc = 0;
      for (let x = 0; x < SIZE; x += 1) acc += grid[y * SIZE + x] * COS_TABLE[u * SIZE + x];
      rows[y * LOW + u] = acc;
    }
  }
  const coefficients = new Float64Array(LOW * LOW);
  for (let v = 0; v < LOW; v += 1) {
    for (let u = 0; u < LOW; u += 1) {
      let acc = 0;
      for (let y = 0; y < SIZE; y += 1) acc += rows[y * LOW + u] * COS_TABLE[v * SIZE + y];
      coefficients[v * LOW + u] = acc;
    }
  }
  // 中位数不含直流分量（整体亮度），否则所有位都只是在比亮度。
  const sorted = Array.from(coefficients.subarray(1)).sort((a, b) => a - b);
  const median = (sorted[31] + sorted[32]) / 2;
  let hi = 0;
  let lo = 0;
  for (let k = 0; k < 64; k += 1) {
    if (coefficients[k] <= median) continue;
    if (k < 32) hi |= 1 << (31 - k);
    else lo |= 1 << (63 - k);
  }
  return (hi >>> 0).toString(16).padStart(8, "0") + (lo >>> 0).toString(16).padStart(8, "0");
}

/** 一帧（或一张图）在给定的内容区域内的哈希与镜像哈希。 */
export function hashRegion(image: GrayImage, content: Rect): { hash: string | null; mirror: string | null } {
  const grid = resampleTo32(image, centerRegion(content));
  return { hash: dctHash(grid), mirror: dctHash(mirror32(grid)) };
}

/** RGBA → 灰度（ITU-R 601 亮度）。 */
export function rgbaToGray(rgba: Uint8ClampedArray, width: number, height: number): GrayImage {
  const data = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 1, p += 4) {
    data[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
  }
  return { width, height, data };
}
