// 为外部 Agent 生成一条只读接口令牌。用法：npm run agent:key -- <agent名称>
//
// 令牌明文只在这里打印一次，交给 Agent 的使用方保存；服务器只需要第二行的
// `名称:哈希`，把它追加进 Vercel 的 AGENT_API_KEYS（多条用逗号分隔）后重新部署。
// 停用某个 Agent：从 AGENT_API_KEYS 删掉它那一条再部署即可。
// 本脚本不连数据库、不读任何环境变量、不发网络请求。
import { mintAgentToken } from "../lib/agent-api/auth";

const name = process.argv[2]?.trim();
if (!name) {
  console.error("用法：npm run agent:key -- <agent名称>   （字母、数字、_ . -，最长 40 个字符）");
  process.exit(1);
}

const { token, entry } = mintAgentToken(name);
console.log(`交给 Agent 的令牌（只显示这一次）：\n  ${token}\n`);
console.log(`追加到 AGENT_API_KEYS 的条目：\n  ${entry}`);
