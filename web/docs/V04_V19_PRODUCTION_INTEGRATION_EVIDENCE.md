# V0.4 V1.9 生产接入 P1／P2｜影子 UI 与真实状态链工程证据

## 1. 范围与停止点

- 批次：P1，仅 UI 壳、版本化 fixture、影子路由与访问门。
- 页面：`/v04-shadow`、`/v04-shadow/videos/:id`、`/v04-shadow/videos/:id/workspace`。
- 默认状态：`V04_UI_SHADOW_ENABLED` 未显式设为 `true` 时返回 404。
- 身份边界：只接受 `V04_UI_SHADOW_REVIEWER_USER_IDS` 中精确匹配的稳定 `users.id`；不使用显示名回退。
- 数据边界：运行时 fixture only；生产 API、数据库、localStorage、indexedDB 引用均为 0。
- 未做：P2、schema APPLY、合同激活、正式入口切换、生产业务数据写入。

## 2. V1.9 基线保护

- 原型只读目录：`prototypes/v04-stage0/`（位于既有 cb41 worktree，未纳入运行时）。
- 原型文件数：64。
- 原型聚合 SHA-256：`9113ea5a48c2016247fa9495983605f3b0420d9a10d38c35e27273cfc2177151`。
- 13 个核心文件 SHA-256 固化于 `v04-ui-fixture.ts`，测试在原型目录存在时逐文件复算。
- P1 仅新增工程说明 §6.1 的 24 个文件；V0.3 正式页面、API、数据库、部署配置与原型均不修改。

## 3. 产品结构对账

| 能力 | P1 结果 |
|---|---|
| 三页面 | 案例库、只读成果、公共工作稿均为独立影子路由 |
| 四模块 | 脚本反写、全片事实与核心判断、主导感知类型发生路径、提交 |
| 逐镜结构 | 每镜 12 项；稳定 ID、全片连续编号、时间承接、五项“同上” |
| 固定／自定义 | 24／15／21 词表；固定集合与自定义文本分源保存；条件必填即时进入发布判断 |
| 五态 | 从 fixture 草稿／不可变提交事实推导，专家优选为独立标签 |
| 编辑交互 | 新增桥段／镜头、上移／下移、跨桥段移动；卡片不可拖，仅手柄可拖动排序 |
| 辅助能力 | 分级导航、未填写定位、历史、批注、AI Mock 建议外壳 |
| 视频 | 页面级单逻辑实例；详情顶部／离屏浮窗、工作稿浮层、最小化与恢复 |
| 旁观态 | fixture 锁持有者不同时，整个编辑 fieldset 禁用，写动作归零 |

## 4. 自动验证

- P1 定向测试：关闭门、稳定 ID 白名单、13 核心 hash、三页面／四模块／12 字段、24／15／21 词表、fixture-only、五态、IME 搜索纯函数、稳定镜头移动、固定／自定义／条件必填。
- 构建：Next.js production build 识别三条影子路由。
- 全量门禁：`npm test`、`npm run lint`、`npm run build`、`git diff --check`。
- 源码边界：影子运行时扫描 `fetch(`、`XMLHttpRequest`、`/api/`、`DATABASE_URL`、`getDbClient`、`localStorage`、`indexedDB`，结果均为 0。

## 5. 本机真实浏览器证据

桌面 1280px：

- 案例库英语、中文、删除／清空、无结果路径均不黑屏；三种案例状态和专家优选独立显示。
- 只读成果输入控件为 0；逐镜分组列数严格为 `3/2/1/2/2/2`；代表镜头高度约 490px；第二、第三模块独立收展。
- 工作稿四模块、三镜头、每镜 12 个字段；卡片 `draggable=0`，手柄 `draggable=3`。
- 跨桥段移动后稳定 ID 不变，编号与导航重算，目标进入视口并高亮。
- 手动保存后最终 `scrollY` 差值为 0，焦点返回同一稳定字段。
- “待形成新机制”清空条件字段后，未填写清单出现且提交禁用。
- AI 生成 2 条建议并显示替换前后预览；批注抽屉显示模块／科目／原文；历史抽屉显示不可变提交与非破坏恢复入口。

窄屏 390×844：

- 三页 `scrollWidth === innerWidth === 390`，无横向溢出。
- 工作稿四模块、每镜 12 项；视频浮层与 AI／批注工具不重叠。
- 只读逐镜分组自然降列，内容完整；案例库状态语义顺序保持。

浏览器日志：无应用 `error`；Next 开发环境 HMR 信息不计入产品错误。影子布局覆盖全局 smooth scroll，以避免影子路由转换产生框架级滚动告警。

## 6. 部署验收口径

P1 提交部署后仅做只读核验：

1. `/api/version` 或等价证据与目标提交 SHA 一致；
2. 未配置影子开关时 `/v04-shadow` 返回 404；
3. V0.3 首页、视频详情、看片与分析、V0.3 工作入口保持正常；
4. 不调用 V0.4 生产 API，不写真实案例，不执行 schema／业务 APPLY。

部署 SHA 与线上核验结果记录在该提交的工程交付回报中，避免为部署后文字再制造第二个代码提交。

## 7. P1-ISSUE-001—005 定向修正证据

统一定位合同：左侧导航、未填写清单、批注抽屉、新增桥段／镜头和镜头移动全部调用同一 `locateV04Target`，执行“双帧等待布局 → 固定页头可见区补偿 → `focus({ preventScroll: true })` → 1.8 秒目标高亮”。发布判断生成的每个 target ID 都通过共享稳定 ID 生成器与渲染 DOM 对应；`field-primaryMechanism-advanced` 不再是虚构目标。

| 视口／动作 | 目标 top / bottom | 焦点 | 高亮／溢出 |
|---|---:|---|---|
| 1280×720 新增桥段 | 338.09 / 382.09 | 新桥段名称 input | 高亮；完全可见 |
| 1280×720 创意母题导航 | 284.59 / 412.09 | `field-creativeMotif-control` | 高亮；不停留导航按钮 |
| 1280×720 PENDING 缺项 | 310.59 / 388.59 | 真实进阶 input | 高亮；完全可见 |
| 1280×720 创意母题批注 | 284.59 / 412.09 | `field-creativeMotif-control` | 高亮；完全可见 |
| 1440×1000 新增桥段 | 478.09 / 522.09 | 新桥段名称 input | 完全可见 |
| 1440×1000 创意母题导航 | 424.59 / 552.09 | `field-creativeMotif-control` | 高亮；完全可见 |
| 1440×1000 PENDING 缺项 | 450.59 / 528.59 | 真实进阶 input | 高亮；完全可见 |
| 1440×1000 创意母题批注 | 424.59 / 552.09 | `field-creativeMotif-control` | 高亮；完全可见 |
| 390×844 新增桥段 | 400.09 / 444.09 | 新桥段名称 input | 高亮；`scrollWidth=390` |
| 390×844 创意母题导航 | 346.59 / 474.09 | `field-creativeMotif-control` | 高亮；`scrollWidth=390` |
| 390×844 PENDING 缺项 | 372.59 / 450.59 | 真实进阶 input | 高亮；`scrollWidth=390` |
| 390×844 创意母题批注 | 346.59 / 474.09 | `field-creativeMotif-control` | 高亮；`scrollWidth=390` |

回归：新增镜头首字段 top / bottom = 338.59 / 381.59，焦点与高亮正确；`shot-aurora-01` 跨桥段后稳定 ID 不变、归属更新为 `bridge-aurora-02`，首字段位于 338.59 / 381.59 且保持焦点与高亮。手动保存 100ms / 600ms 的 `scrollY` 差值均为 0，焦点保持在同一创意母题字段。文字选择得到完整“欢迎回家”；镜头卡 `draggable=false`，仅手柄 `draggable=true`。新的窄屏导航保留科目按钮且只在导航容器内横向滚动，页面无横向溢出。干净验收 tab 的 console error / warn 均为 0。

`本桥段关键创意描述` 改为无“发布必填”标识；自动测试已比对全部桥段该字段清空前后的 `ready` 和 `missing` 完全一致，未改变发布计数规则。P1 定向产品复验结论：A。

## 8. R1｜现有系统共享底座、真实 API 与状态链

### 8.1 复用边界与接线范围

- 现有 `/api/videos` 继续是唯一视频目录、标签与上传来源；V0.4 cards API 只接收这些既有 video ID，并投影 V0.4 工作状态、版本和查看者能力，既不返回另一套视频目录，也不复制标题、品牌、标签或上传信息。
- 案例详情、公共工作稿和统一历史 read model 由服务端真相源生成；GET 使用 `no-store`，且领域验证证明零写。
- `v04-ui-api-client` 是 V0.4 共享组件的统一 API 适配层；`/v04-shadow` 仍只是测试／恢复外壳，不是正式产品入口或第二套应用。
- 媒体只复用现有 video ID、`/api/videos/[id]/stream` 与既有预签名能力；V04 播放器仅封装共享会话状态，不建立第二套媒体对象或鉴权。
- 登录用户、稳定 user ID、管理员／专家身份全部复用既有服务端身份体系；V0.4 客户端不自建用户或权限目录。
- 自动／手动保存携带稳定 tab、lease proof、expected revision/hash 和 change set；冲突保留本地输入。
- 提交创建独立不可变 V1／V2；提交不释放当前租约。专家优选精确绑定提交 ID 和版本号，不参与五态。
- 历史恢复只创建新的 working revision；旧提交、初始基线、专家优选和批注均保留。
- V0.4 批注新增 GET／POST／状态更新路由；批注绑定当前 WORKING snapshot 与稳定 target，不接受调用方注入 snapshot ID。
- 媒体 read model 只返回稳定 video ID、站内 stream／metadata path 和对象元数据；短期 URL 不进入工作稿、提交或历史。

### 8.2 首次安装前 trigger 基线纠错

P2 首次真实浏览器物化暴露 1A 未投产 DDL 的通用触发器缺陷：`collaboration_baselines` 行会访问不存在的 `NEW.round_id`。生产仍为 pre-1A，未执行该 migration；因此按批准范围在首次安装前修正，不属于生产 drift 或数据迁移。

修正后按 `TG_TABLE_NAME` 明确分支，只在对应表分支读取该表实际字段；关系约束、不可变规则和失败可见性保持不变。TypeScript bootstrap DDL 与版本化 SQL migration 的 catalog 一致。

| 证据 | 修正前历史 SHA-256 | 修正后有效 SHA-256 |
|---|---|---|
| `db/v04-schema.ts` | `b2ebcec03a67b7161cfb3772a908013ce453913a5c73e44d6f8dd2c3f00e1175` | `262aa2d19a43a2b039588724ae7df7d0b445c6cb6e142b4a74d02bbae3e17286` |
| `db/migrations/2026-08-19-v04-contract-foundation.sql` | `a7ffc1d13d61c9c648a11fa102f775c1d5155229820a166f948f876be82b671c` | `21048e264b8f93fc1d67e1f7b59b4b26520b1c10ee343ebd4fe97e1cd1429fea` |

真实 PostgreSQL 逐表矩阵覆盖 workspace、baseline、round、submission、revision、lease、expert：合法关系均可写入；跨 workspace／canonical annotation／round／submission 均被拒绝；不可变表仍拒绝更新。`verify:v04-schema` 得到 bootstrap／migration 相同 catalog hash：`43a33111869129e92f82ae8a5cc1b33dd753cb2cc3dc5d39dfbd8d4cf244fe5b`。

### 8.3 TEST_ONLY PostgreSQL 证据

| 门 | 结果 |
|---|---|
| 1A schema | 空／历史安装、重复执行、drift 回滚、15/15 RLS、60 词表、DRAFT 合同通过；public 指纹不变 |
| 1B workflow | 两用户／双 tab、TTL、rebase／冲突、V1／V2、幂等、失败回滚、专家、恢复、软删除和 RLS 通过 |
| 1C PREVIEW | pre-1A fail-closed 管理员映射、P01—P11、token 稳定／过期、catalog drift、GET 零写通过 |
| R1 trigger | 每张关系 trigger 挂载表的合法／非法关系通过；首次 materialize → lease → save 成功 |

关键结构化结果：`logicalEmptyGetWrites=0`、`uniqueWorkspace=1`、`firstSubmissionNumber=1`、`secondSubmissionNumber=2`、`failedSubmissionConsumedNumber=false`、`readModelsZeroWrite=true`、`publicFingerprintUnchanged=true`。

### 8.4 共享组件本机真实浏览器闭环

- 案例库 → 空只读成果 → 公共工作稿：打开空工作区未创建 workspace／lease；首次有效编辑后原子物化并保存，状态由“尚未开始”变“尚未完成”。
- 填写逐镜 `subtitleEffect`、固定／自定义字段和四模块必填项后提交 V1；只读页输入控件为 0，立即显示完整 V1。
- 修改评价理由后状态立即变“有修改未提交”；提交 V2 后为“修改已提交”，原编辑者继续持有租约。
- 专家优选精确绑定 V1；只读页可在最新 V2 与优选 V1 间切换，正文互不污染。
- 新建并处理创意母题批注；抽屉显示模块、科目、原文摘要、作者和状态，定位后焦点为 `field-creativeMotif-control`。
- 从历史 V1 创建恢复稿后状态为“有修改未提交”；V1、V2 与专家优选仍可读取。
- 同用户刷新产生新 tab token 时被旧租约拒绝；旧租约过期后新 tab 自动取得编辑权。第二名普通成员只能读取、批注，申请已占用租约返回 `LEASE_HELD_BY_OTHER`。
- 手动保存前后 `scrollY=1745.5`、焦点 `field-creativeMotif-control`，位移为 0；保存不提交、不释放租约。
- PENDING 主机制缺项定位到真实 `field-primaryMechanism-advanced` input；批注定位、未填写定位和导航继续复用统一定位实现。
- 390×844：案例库、只读页、工作稿均 `scrollWidth === innerWidth === 390`；只读输入 0，工作稿 12 项与单视频实例保留。

### 8.5 R1 停止点

R1 只形成共享底座代码：`V04_UI_SHADOW_ENABLED` 与 `V04_WORKFLOW_API_ENABLED` 均保持默认关闭；不执行生产 schema APPLY、合同激活、历史回填、生产写入或正式入口切换。R1 与后续 R2 分开提交；R2 才会把已验收共享组件以受控分支接入现有 `/videos/[id]/practice`。自动门禁为 `npm test` 263 项（258 通过、5 项显式 opt-in 跳过）、lint、production build 和 `git diff --check` 全部通过；TEST_ONLY PostgreSQL 的 1A schema、1B workflow、1C PREVIEW 与逐表 trigger 矩阵全部通过。当前状态：**R1 工程完成，待统筹／产品复验**。

## 9. R2｜现有工作页受控接入

### 9.1 路由与复用边界

- 现有 `/videos/[id]/practice` 仍是唯一正式工作路由；只有显式 `taxonomy=V0.4` 且服务端 `V04_WORKFLOW_UI_ENABLED=true` 时，才渲染共享的 `V04WorkspaceClient` 与 `V04VideoSessionProvider`。
- 页面继续先调用现有 `requirePageUser`，并把同一个 video ID 传给 V0.4 组件；没有新增登录、用户、视频、上传、媒体或正式 workspace 路由。
- 无 taxonomy 和未知 taxonomy 均继续落到 `V0.3-PILOT`；显式 `V0.2` 保持原行为。既有 `PracticeClient.tsx` SHA-256 保持 `80689400bd930b8f6bd0dfc565a01b7a238cc60dcb973f138060a8ca3ee053d7`。
- V0.4 工作稿页头返回现有案例库和作品详情；`/v04-shadow` 继续保留为验收／恢复外壳，不再扩大业务职责。
- `V04_WORKFLOW_UI_ENABLED` 与 `V04_WORKFLOW_API_ENABLED` 都没有写入部署配置；生产默认关闭，暗代码部署不会开放 V0.4 模式。

### 9.2 R2 验收停止点

本机仅在 TEST_ONLY 数据库和本地显式开关下验证 `taxonomy=V0.4` 的四模块、逐镜 12 字段、保存／提交／历史／租约与桌面／窄屏路径。不开生产 schema、不激活合同、不写生产案例、不改变默认 taxonomy。R1 已获产品 A；R2-ISSUE-001 定向修正后，当前停止状态为：**待 R2 定向产品真实路径复验**。

### 9.3 本机现有路由证据

- 在本机 TEST_ONLY 数据库、`V04_WORKFLOW_UI_ENABLED=true` 与 `V04_WORKFLOW_API_ENABLED=true` 下，打开 `/videos/test_v04_video/practice?taxonomy=V0.4`，页面直接呈现四模块；新增首个桥段后出现一镜 12 个独立输入，保存成功，工作状态由“尚未开始”变为“尚未完成”。
- 页头实际链接为现有 `/`、`/videos/test_v04_video` 与同一路由的 `?taxonomy=V0.4`；页面逻辑播放器实例为 1，没有进入 `/v04-shadow`。
- 同一登录用户在第二个标签页打开相同 URL 时，新的 tab token 被现有租约隔离；页面显示“只读旁观”，原标签页仍保留编辑权。初版使用整页 disabled fieldset，错误连带禁用了旁观者的模块收展和定位；该回归已在 9.4 以结构性拆分修正。
- 关闭两个 V0.4 本地开关后，显式 `taxonomy=V0.4` 返回真实 404；无 taxonomy 的同一 URL 继续呈现 `体系 V0.3-PILOT`，没有 V0.4 页面标记。
- 共享 V1.9 组件的 P1 390×844 实测结果（页面无横向溢出、四模块、逐镜 12 项、单视频）未因 R2 改变：本批没有修改 CSS、逐镜编辑器或响应式结构，只增加现有 practice 的服务端选择分支与可配置页头链接。当前 in-app 验收视口为 1910×1075；390px 物理复验沿用已冻结的同组件 P1 证据，待产品真实路径复验再次确认。
- 浏览器 error／warn 为 0。完整自动门禁为 `npm test` 266 项（261 通过、5 项显式 opt-in 跳过）、lint、production build 与 `git diff --check` 全部通过。

### 9.4 R2-ISSUE-001｜旁观态只读交互定向修正

- 根因：工作稿正文原先整体包在 `<fieldset disabled={!canEdit}>` 中。HTML 原生 disabled 语义会同时切断输入写入、模块收展按钮、缺项定位按钮及被定位字段的 focus，因此把“没有编辑租约”错误扩大成“页面不可交互”。
- 修正：移除整页 disabled fieldset；文本控件统一使用可聚焦、可选择文字但不可写的 `readOnly`，选择值、路径、移动、新增、保存、提交、恢复、专家优选和批注写入分别按 `canEdit` 禁用，并在写函数入口增加客户端二次守卫。服务端租约、权限和事务逻辑未改。
- 只读入口：第二／第三模块收展、模块／科目导航、未填写项目、批注定位统一经过同一定位函数；目标位于已收起模块时先展开、等待布局，再执行既有的可见性校正、focus 与高亮。历史抽屉在旁观态不提供恢复按钮；批注抽屉保留查看／定位但不渲染新增或状态修改动作；AI Mock 外壳仍可阅读和本地演示。
- 静态契约：`v04-ui-baseline.test.ts` 新增旁观态断言，禁止整页 disabled fieldset 回退，验证 readOnly／mutation disabled／函数守卫／统一定位／只读历史与批注边界。完整 `npm test` 为 267 项（262 通过、5 项显式 opt-in 跳过），`npm run lint`、Turbopack production build、Webpack production build 与 `git diff --check` 均通过。
- TEST_ONLY 服务证据：同一稳定用户、两个 tab token 读取同一 `test_v04_video`；tab A 持租约时 `canEdit=true`，tab B 为 `canEdit=false` 且仍有读取／批注能力；tab B 申请租约返回 HTTP 423 `LEASE_HELD_BY_OTHER`。tab A 精确释放后，tab B 取得租约并变为 `canEdit=true`，最后精确释放；工作稿 revision 始终为 2，本轮未保存、提交、恢复、优选或修改正文。
- 浏览器限制：代码工程任务尝试在已连接的应用内浏览器刷新本机 `localhost:3000` 验收页时，被浏览器自身 URL 安全策略拒绝；未使用其他浏览器或自动化绕过。因此 1280／1440／390 的定向点击项必须由产品真实路径复验补齐，工程回报不得把本节写成产品 PASS。

## 10. R3／R4｜现有详情与片库增量接入

### 10.1 R3 现有详情

- 现有 `/videos/[id]` 仍负责登录、视频元数据、播放器、V0.3 公共工作稿、批准版和历史；没有新增第二详情路由。
- `V04DetailClient` 增加可嵌入模式：复用 V1.9 四模块只读成果，但不再渲染第二个页头或播放器。
- 只有服务端 `V04_DETAIL_UI_ENABLED=true` 时才挂载嵌入区；无 V0.4 提交时显示空成果态，有提交时默认显示 latest，有专家优选时可与 latest 显式切换。
- 该区只调用 `detail` GET，不保存、提交、恢复或物化；现有 V0.3 历史仍在同页原位呈现。

### 10.2 R4 现有片库

- `/` 与 `GET /api/videos` 仍是唯一片库和视频元数据真相源；搜索、上传、标签、原卡片和 V0.3 入口均保留。
- `V04_LIBRARY_UI_ENABLED=true` 时，客户端仅用当前 `video_id` 批量读取 V0.4 投影，附加五态、专家优选、查看成果与工作稿入口；不返回、不复制第二套视频列表。
- 投影读取失败时只降级 V0.4 附加信息，既有片库继续可见可用，避免暗能力影响正式主链。

### 10.3 开关、回退与禁改证据

- `V04_DETAIL_UI_ENABLED` 与 `V04_LIBRARY_UI_ENABLED` 都不在 `vercel.json` 中，生产默认关闭；关闭时详情与首页不发起 V0.4 请求，回退为不配置开关。
- `PracticeClient.tsx` SHA-256 仍为 `80689400bd930b8f6bd0dfc565a01b7a238cc60dcb973f138060a8ca3ee053d7`；`app/api/videos/route.ts` SHA-256 仍为 `df2ecde0ca38ce307d651f639fbe43e3a9cf13a9b7f7d00d2ca0a82917f7984f`。
- R3 和 R4 分别形成独立本地提交；R2 获得产品 A 前不合并、不推送 `main`，不执行 schema APPLY、合同激活、生产写入或正式开关。

### 10.4 TEST_ONLY 真实浏览器证据

- 1280×720 现有首页：6 张原案例卡与 6 个 V0.4 投影一一对应，`innerWidth=scrollWidth=1280`；搜索 `v04` 后只保留 1 张原卡和其 1 个投影，现有搜索与卡片源没有被替换。
- 1280×720 现有详情：V0.4 嵌入区宽 1216px，页面 `scrollWidth=innerWidth=1280`；同页仍有 1 个逻辑播放器、V0.2／V0.3 历史和 V0.4 空提交态，V0.4 嵌入区写控件为 0。
- 390×844 现有首页：6 张卡片与 6 个投影均在 16—374px 安全边界内，`innerWidth=scrollWidth=390`。
- 390×844 现有详情：V0.4 嵌入区位于 16—374px，`innerWidth=scrollWidth=390`，视频实例为 1，V0.3 历史仍在，空成果文案和 V0.4 工作稿入口可见。
- 无 taxonomy 的现有 V0.3 工作页仍显示 `体系 V0.3-PILOT`，V0.4 页面标记为 0；成功验收 tab 的 console error／warn 为 0。
- 页面读取全部使用 loopback TEST_ONLY PostgreSQL；未保存、提交、恢复、优选或写入真实案例。latest／expert 双版本选择由服务端 read model 与组件契约测试覆盖，本轮真实浏览器使用现有空提交样本验收，不为补画面而制造新业务版本。
