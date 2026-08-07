export function replacementObjectKey(videoId: string, assetId: string) {
  return `videos/${videoId}/replacements/${assetId}`;
}

export function replacementThumbnailKey(videoId: string, assetId: string) {
  return `videos/${videoId}/replacements/${assetId}-thumbnail.jpg`;
}

// The client only ever hands back an opaque asset id; object keys are rebuilt on the
// server so a replacement can never be pointed at an unrelated object in the bucket.
export function isReplacementAssetId(value: unknown): value is string {
  return typeof value === "string" && /^asset_[0-9a-f-]{36}$/.test(value);
}
