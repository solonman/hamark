// 外部 Agent 只读接口的自描述入口：列出可用端点与参数，方便 Agent 首次接入时自查。
// 规格见 docs/23_外部Agent只读API_V0.1.md。
import { agentRoute } from "@/lib/agent-api/route";
import { AGENT_LIST_DEFAULT_LIMIT, AGENT_LIST_MAX_LIMIT } from "@/lib/agent-api/params";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return agentRoute(request, {}, async ({ agent, owner }) => ({
    name: "hamark 案例只读接口",
    version: "v1",
    agent,
    owner,
    auth: "Authorization: Bearer <token>（令牌在站内 /agent-tokens 生成）",
    readOnly: true,
    listParams: {
      limit: `每页条数，默认 ${AGENT_LIST_DEFAULT_LIMIT}，最大 ${AGENT_LIST_MAX_LIMIT}`,
      offset: "跳过条数，默认 0",
      q: "按标题／品牌（报告为任务类型）／标签模糊搜索",
      hasAnalysis: "true 时只返回已有拆解版本的案例",
      updatedSince: "ISO 8601；只返回拆解内容在此之后有更新的案例（增量同步用）",
    },
    analysisParams: {
      version: "final（集成版，默认）| latest（最近保存的个人版本）| <版本 id>",
      format: "both（默认，payload + readable）| raw | readable",
    },
    endpoints: [
      { method: "GET", path: "/api/agent/v1/videos", description: "视频案例列表（含拆解进度摘要）" },
      { method: "GET", path: "/api/agent/v1/videos/{id}", description: "视频案例详情：元数据、视频与封面签名链接、版本列表、集成版状态" },
      { method: "GET", path: "/api/agent/v1/videos/{id}/analysis", description: "视频逆向拆解内容（逐镜脚本、全片判断、感知路径）" },
      { method: "GET", path: "/api/agent/v1/reports", description: "报告案例列表（含拆解进度摘要）" },
      { method: "GET", path: "/api/agent/v1/reports/{id}", description: "报告详情：元数据、逐页页图签名链接与文字摘录、相关资料、版本列表、集成版状态" },
      { method: "GET", path: "/api/agent/v1/reports/{id}/analysis", description: "报告逆向拆解内容（背景、策略、模块／单元结构、逐页组块）" },
    ],
  }));
}
