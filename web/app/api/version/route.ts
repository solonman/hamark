export const dynamic = "force-dynamic";

// 每个部署在构建时携带自己的 commit SHA；老页面轮询到新 SHA 即提示刷新。
export async function GET() {
  return Response.json(
    { version: process.env.VERCEL_GIT_COMMIT_SHA || "dev" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
