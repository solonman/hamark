# V0.4 V1.9 桌面浏览器兼容性审计与安全门 V1.0

- 审计日期：2026-08-23（Asia/Shanghai）
- 代码基线：`43306dc3ac66059136c63b10db1a2efe4c5bb803`
- 范围：正式 V1.9 案例库、只读成果、工作稿及上传/视频所依赖的浏览器能力
- 边界：未连接生产数据库，未读取或写入 BUSINESS 案例正文，未修改 schema、RLS、权限、V0.2/V0.3、保存/提交事务
- 当前结论：确定性能力缺口已用编辑前 fail-closed 门修复；跨 Windows/macOS 的 FULL 实机矩阵仍需设备证据，不能表述为全平台 A

## 1. 真实工程边界

| 项目 | 当前事实 |
| --- | --- |
| Next.js | 16.2.12 |
| React | 19.2.6 |
| TypeScript | 5.9.3；`target=ES2017`、DOM/ESNext lib |
| Browserslist | 项目未自定义，沿用 Next 16 默认：Chrome 111+、Edge 111+、Firefox 111+、Safari 16.4+ |
| Polyfill | 无项目自定义；Next 只内建 fetch、URL、Object.assign 等通用 polyfill，不替代 Web Locks、`structuredClone`、`crypto.randomUUID` |
| CSS | V1.9 使用 Grid、sticky、aspect-ratio、clamp、backdrop-filter；上传禁用态使用 `:has()`，它不参与保存安全 |

Next 官方支持口径：<https://nextjs.org/docs/architecture/supported-browsers>。

## 2. 兼容分层矩阵

| 层级 | Windows Chrome | Windows Edge | Windows Firefox | macOS Chrome | macOS Firefox | macOS Safari |
| --- | --- | --- | --- | --- | --- | --- |
| 当前/前1/前2 | 代码/能力门可支持；待 Windows 实机 | 代码/能力门可支持；待 Windows 实机 | 代码/能力门可支持；待 Windows 实机 | 当前 Chrome 151 已安装但当前控制通道不可用；待实机链 | 无现成运行时；待实机 | 当前 Safari 26.5 已安装但无可用自动控制；前两版待实机 |
| 正式最低线 | 111+ | 111+ | 111+ | 111+ | 111+ | 16.4+ |
| 明显旧办公版（选定） | Chrome 109：BLOCKED | Edge 109：BLOCKED | Firefox 102 ESR：BLOCKED | Chrome 109：BLOCKED | Firefox 102 ESR：BLOCKED | Safari 15.6：BLOCKED |
| IE11 / EdgeHTML | IE11：UNSUPPORTED；EdgeHTML：UNSUPPORTED | 同左 | 不适用 | 不适用 | 不适用 | 不适用 |

说明：正式最低线来自框架合同和能力门，并不替代 FULL 实机证据。未安装的 Firefox/WebKit、Windows Edge/Chrome/Firefox，以及 Safari 前两个版本均不得用 Chromium 自动测试冒充。

## 3. 关键 Web API 与降级

| 能力 | V1.9 用途 | 正式线状态 | 缺失/异常后的冻结行为 |
| --- | --- | --- | --- |
| Web Locks | 同源双标签文档身份的原子所有权 | 编辑必需，HTTPS | 在挂载工作稿前真实请求唯一探测锁；缺失、拒绝、挂起、超时均 BLOCKED，不生成临时可编辑身份 |
| BroadcastChannel | 当前主链未使用 | 非必需 | 不作为兼容或正确性证据 |
| sessionStorage | 同标签刷新保持非凭据文档身份 | 编辑必需 | 无业务数据写删探测失败即 BLOCKED |
| localStorage | 无凭据本地恢复副本 | 编辑必需 | 无业务数据写删探测失败即 BLOCKED；不误报服务器已保存 |
| `crypto.randomUUID` | 请求、标签、变更/提交幂等标识 | 读写页面必需 | 缺失即 BLOCKED；禁止弱随机替代 |
| `structuredClone` | 草稿、结构值、三方合并 | 读写页面必需 | 缺失即 BLOCKED；禁止有损 JSON clone |
| AbortController | 15 秒网络边界、锁探测取消 | 必需 | 缺失即 BLOCKED |
| fetch / ReadableStream | API、媒体/上传浏览器能力 | 必需 | 缺失即 BLOCKED；Next fetch polyfill不被视为其他能力证明 |
| FormData / File | 现有上传 | 案例库必需 | 缺失即 BLOCKED，不复制上传链 |
| HTMLVideoElement | 现有媒体、stream、单播放器 | 只读/工作稿必需 | 缺失即 BLOCKED |
| IntersectionObserver | 工作稿导航随滚动激活 | 当前实现必需 | 缺失即 BLOCKED，避免挂载后抛错 |
| ResizeObserver | 当前 V1.9 主链未直接依赖 | 非必需 | 不作为编辑门 |
| pagehide / beforeunload / visibility / online | 离页恢复、后台/联网恢复 | 编辑必需 | 能力不完整即 BLOCKED；关闭页不承诺异步服务器保存，本地恢复仍是硬兜底 |
| `crypto.subtle` | 主要用于服务端/管理员摘要，不是正式工作稿浏览器主链 | 非编辑门 | 不把它误列为工作稿必需项 |

## 4. 定向修复

1. 正式 `/`、`/videos/[id]`、`/videos/[id]/practice` 在渲染 V1.9 子组件前运行能力门；门未通过时子组件不挂载。
2. 已知低于正式底线的 Chrome/Edge/Firefox/Safari，以及 IE11/EdgeHTML，由服务端 UA 拒绝壳直接返回自然语言升级指引。UA 只用于拒绝已知旧引擎，不用于宣称兼容。
3. 编辑模式额外验证 sessionStorage/localStorage 可写可删，以及 Web Lock 能在 1.5 秒内真实获得；失败时工作区 GET、编辑状态、恢复写入、save、submit 均不会启动。
4. `V04VideoSessionProvider` 二次拒绝任何 `failClosed` 临时身份，防止能力在探测后发生变化时继续编辑。
5. 显式 V0.3/V0.2 兼容入口绕过 V0.4 能力门，相关旧组件字节未改。

## 5. 可重复证据

### 自动与数据库

- 定向兼容测试：正常能力、缺 `structuredClone`/UUID/生命周期/observer、storage 抛错、Web Locks 缺失/拒绝/永久挂起、Chrome/Edge 109、Firefox 102、Safari 15.6、IE11、EdgeHTML、服务端壳无表单控件均通过。
- `npm test`：Webpack build 通过；435 tests，426 pass、9 个显式环境 skip、0 fail。
- 显式 `TEST_ONLY` PostgreSQL：双用户/双标签、租约、非重叠 rebase、同字段冲突、V1/V2 提交、幂等、失败回滚、恢复、专家、RLS、GET 零写、公共指纹不变全部通过。
- V0.3 `PracticeClient.tsx` 和旧 `/api/videos` 既有哈希测试继续通过。

### 本机浏览器与 HTTP

- 本机 IAB（Chromium 类控制面）缺少完整安全身份能力：正式工作稿在挂载前显示自然语言 BLOCKED，DOM 无 V1.9 编辑控件；这是正确降级证据，不作为 Chrome FULL 证据。
- 带本地 TEST_ONLY 已登录会话的 IE11 与 Chrome 109 UA 请求：服务端均返回“请升级或更换浏览器／没有进入编辑状态”，无 `input`、`textarea`、`form`。
- 同一 IE11 UA 的显式 `?taxonomy=V0.3-PILOT` 仍返回旧兼容页面，不经过 V0.4 阻断。
- 本机只有 Chromium 自动运行时；Playwright Firefox/WebKit 未安装。未下载任何软件或浏览器。

## 6. 企业执行口径

- 推荐最低：Chrome 111+、Edge 111+、Firefox 111+、Safari 16.4+；优先使用当前稳定版或前两个大版本。
- IE11、EdgeHTML 永久不支持；员工应升级或改用 Edge/Chrome。
- 低于最低线即使偶然具备部分 API，也不开放 V1.9 编辑。
- 能力门通过仍不等于该 OS/浏览器 FULL 已验收。发布“Windows/macOS 全兼容”前，需在真实 Windows Edge/Chrome/Firefox 与真实 macOS Safari/Chrome/Firefox 完成两条 TEST_ONLY 链（新填 V1、修订 V2）及桌面/390、恢复、双标签、视频、上传复验。
