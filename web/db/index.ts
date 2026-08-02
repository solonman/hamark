import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

type AppBindings = {
  DB: D1Database;
  VIDEOS: R2Bucket;
};

function getBindings() {
  return env as unknown as AppBindings;
}

export function getD1() {
  const binding = getBindings().DB;
  if (!binding) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB`.",
    );
  }
  return binding;
}

export function getDb() {
  return drizzle(getD1(), { schema });
}

export function getVideoBucket() {
  const binding = getBindings().VIDEOS;
  if (!binding) {
    throw new Error(
      "Cloudflare R2 binding `VIDEOS` is unavailable. Set the `r2` field in .openai/hosting.json to `VIDEOS`.",
    );
  }
  return binding;
}
