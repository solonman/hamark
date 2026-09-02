# 报告转换 · 两种后端

上传的 PPT/PPTX/PDF 要转成两档 JPEG 页图（缩略图 ≈480w、大图 ≈1600w）加页文字摘录，
写进 `reports` / `report_pages`。有两条互斥的转换后端，`REPORT_CONVERTER` 环境变量
选择用哪条（默认按下面的规则自动选）：

| 后端 | 触发方式 | 需要什么 | 状态机 |
|---|---|---|---|
| **`ci`**（数据万象，默认） | `completeReportUpload`/`retryReport` 直接提交，Vercel 上就能跑，不用自维护机器 | 生产 COS 四件套环境变量 + 存储桶已开通「文档处理」 | `UPLOADING → QUEUED → PROCESSING`（提交两个 doc_jobs）`→ READY/FAILED`（CI 回调或轮询兜底收口） |
| **`script`**（本文档下面讲的离线脚本） | 状态留在 `QUEUED`，等 `scripts/convert-report-pages.ts` 来领 | 一台装了 LibreOffice/poppler 的常驻离线机 | 同上，但 `PROCESSING→READY/FAILED` 由离线脚本推进 |

**默认选择逻辑**（`lib/report-converter.ts` 的 `chooseConverterMode`）：`REPORT_CONVERTER`
显式设成 `ci` 或 `script` 时以它为准；否则本机演示模式（`LOCAL_DEMO_MODE=1`，没有真
COS）一律退回 `script`；否则只要生产的 `COS_REGION`/`COS_BUCKET`/`COS_SECRET_ID`/
`COS_SECRET_KEY` 四个环境变量齐全就默认 `ci`。**这意味着生产环境（Vercel）不需要再
起一台离线机——上线后默认就是 `ci` 后端，`script` 只在本机联调、或数据万象出问题时
临时切回来用。**

## `ci` 后端：数据万象文档转码

原理：`completeReportUpload`/`retryReport` 直接向数据万象（腾讯云 CI）的文档转码
接口 `POST /doc_jobs` 提交两个异步任务（大图一个、小图一个，各自用
`imageMogr2/thumbnail/<width>x/quality/<q>` 生成对应尺寸），报告状态推进到
`PROCESSING`；任务做完后，数据万象回调 `POST /api/reports/ci-callback?token=…`，
或者报告库列表/详情接口在报告卡在 `PROCESSING` 超过 15 秒时顺手查一次任务状态——
两条路径最终都调用 `lib/report-converter.ts` 的 `checkReportCiJobs`，按页合并两个
任务的查询结果、`upsert report_pages`、把报告置 `READY`（或 `FAILED`）。

**队列不需要手动创建**：存储桶「文档处理」开通时数据万象会自动建一条默认名叫
`queue-doc-process-1` 的队列；代码首次提交任务前调一次 `GET /docqueue` 自动发现
一条 `State=Active` 的队列并缓存在进程内，`COS_CI_DOC_QUEUE_ID` 只是可选的手动覆盖
项（多条队列时想指定用哪条才需要设它），不设置也能正常工作。

**控制台需要开通的清单**（写给非技术同学）：

1. 确认要用的存储桶（生产是 `hamark`，`ap-shanghai`）在数据万象控制台里「文档处理」
   显示「已开启」——**只需要这一步**，不需要额外创建转码队列，也不需要手动配置
   回调地址（代码自己在每个任务里带上回调 URL，收不到回调时列表/详情页面也会自己
   轮询兜底，两条路径都会收口）。
2. 确认生产环境（Vercel）已经配置好 `COS_REGION`/`COS_BUCKET`/`COS_SECRET_ID`/
   `COS_SECRET_KEY`——这几个视频功能已经在用，通常已经配好，不用重新申请。
3. 确认生产的 `APP_URL` 指向公网可达的正式域名——回调 URL 会拼在这个域名下；就算
   回调一时收不到（内网、防火墙等），轮询兜底也能兜住，只是会晚几秒到十几秒看到
   进度，不影响最终转换成功。

**环境变量（`ci` 后端专用）**：

| 变量 | 默认值 | 作用 |
|---|---|---|
| `REPORT_CONVERTER` | 自动选择（见上面的规则） | 显式指定 `ci` 或 `script`，覆盖自动选择 |
| `COS_CI_DOC_QUEUE_ID` | 自动发现 | 可选：手动指定队列 id，跳过 `GET /docqueue` 自动发现（多队列时想指定用哪条才需要） |

其余 `COS_REGION`/`COS_BUCKET`/`COS_SECRET_ID`/`COS_SECRET_KEY`/`APP_URL` 复用项目
已有的环境变量，不需要新增。

**迁移**：`ci` 后端要用到的四个新列（`ci_job_large`/`ci_job_small`/
`ci_callback_token`/`ci_checked_at`）在 `db/migrations/2026-09-02-report-ci.sql`——
附加式、只加列、可重复执行，在 Supabase SQL 编辑器整段执行即可（跟
`2026-09-02-report-reverse.sql` 一样，不要用 `npm run db:migrate`）。

**没配够 `ci` 后端要求的环境变量时会怎样**：`chooseConverterMode` 自动退回
`script`，行为跟没做这次改造之前完全一样（报告停在 `QUEUED`，等离线脚本来领）。

**`ci` 后端的核对依据**（2026-09-02 核对，如与实际响应不一致以数据万象实际返回
为准）：

- 提交文档转码任务 `POST /doc_jobs`：<https://cloud.tencent.com/document/product/460/46942>
- 查询指定的文档转码任务 `GET /doc_jobs/<JobId>`：<https://cloud.tencent.com/document/product/460/46943>
- 查询文档处理队列 `GET /docqueue`：<https://cloud.tencent.com/document/product/460/46946>
- 开通文档处理会自动建队列，不需要手动建：<https://cloud.tencent.com/document/product/460/103608>

## `script` 后端：离线机

`scripts/convert-report-pages.ts` 把上传的 PPT/PPTX/PDF 逐页转成两档 JPEG 并抽文字，
写进 `reports` / `report_pages`。跟 `scripts/backfill-thumbnails.ts` 一样，在一台常驻
的离线机上跑，不进 Next.js 的请求路径。判断逻辑（重试、降级、失败原因）在
`lib/report-convert.ts` 里，有单测；这个脚本只管编排。**只有 `REPORT_CONVERTER=script`
（或没配够 `ci` 的环境变量、或本机演示模式）时报告才会停在 `QUEUED` 等这个脚本来
领；生产默认是 `ci` 后端，不需要跑这个脚本。**

状态机与分级兜底顺序见 `docs/19_报告逆向工程_实施规格_V0.1.md` 第四节。

## 安装依赖

### macOS（本项目实际用的开发/演示机型）

```bash
brew install poppler                 # 提供 pdftoppm / pdftotext / pdfinfo
brew install --cask libreoffice      # 提供 soffice
```

中文字体（缺字体不算转换失败，但缺得太多会导致排版明显跑位，建议装全）：

```bash
brew install --cask font-source-han-sans font-source-han-serif   # 思源黑体／思源宋体
```

如果原始 PPT 用了微软雅黑、方正系列等商用字体，离线机上装不到正版字体时，可以用
`fontconfig` 把它们映射到已装的开源替代字体（而不是让 soffice 报字体缺失）。在
`~/.config/fontconfig/fonts.conf` 里加：

```xml
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <match target="pattern">
    <test name="family"><string>微软雅黑</string></test>
    <edit name="family" mode="assign" binding="strong"><string>Source Han Sans SC</string></edit>
  </match>
  <match target="pattern">
    <test name="family"><string>方正兰亭黑</string></test>
    <edit name="family" mode="assign" binding="strong"><string>Source Han Sans SC</string></edit>
  </match>
</fontconfig>
```

改完跑一次 `fc-cache -f` 生效。这类替换会被脚本收进 `convert_notes`（不算失败，
不会在报告库卡片上报错，只在工作台的"来源信息"里能看到）。

### Linux（同款离线机换成 Linux 时对应装法）

```bash
sudo apt-get update
sudo apt-get install -y poppler-utils libreoffice fonts-noto-cjk
```

`fonts-noto-cjk` 覆盖大部分中文渲染场景；商用字体替代映射同上，配置文件路径一致。

## 验证安装

```bash
soffice --version
pdftoppm -v
pdftotext -v
pdfinfo -v
```

四个命令都能正常输出版本信息即算装好。脚本自己启动时也会做同样的探测，缺哪个就用
中文报错退出，不会跑到一半才发现装漏了。

## 运行

正式离线机（生产凭据，`.env.local`）：

```bash
# 持续轮询，每次捞一份 QUEUED 的报告处理，处理完继续等下一份
node --env-file=.env.local --import tsx scripts/convert-report-pages.ts
# 等价的 npm script：
npm run convert:report-pages

# 只处理一份就退出（没有排队中的也直接退出，不等待）——适合手动跑一次或配合 cron
node --env-file=.env.local --import tsx scripts/convert-report-pages.ts --once

# 只处理指定的一份报告（必须是 QUEUED 状态），处理完就退出——用于人工重跑
node --env-file=.env.local --import tsx scripts/convert-report-pages.ts --report <reportId>
```

本机开发联调（连本机 homebrew Postgres 等本地资源的 `.env.development.local`）：

```bash
npm run convert:report-pages:local
# 等价于：
NODE_ENV=development node --env-file=.env.development.local --import tsx scripts/convert-report-pages.ts

# --once / --report <reportId> 同样适用，直接接在后面：
NODE_ENV=development node --env-file=.env.development.local --import tsx scripts/convert-report-pages.ts --once
NODE_ENV=development node --env-file=.env.development.local --import tsx scripts/convert-report-pages.ts --report <reportId>
```

两者的唯一区别是连的哪个环境（凭据、对象存储桶不同）：`.env.local` 是生产凭据，只在
真正的离线转换机上用；本机调试报告库功能（建条目、看列表/详情）时，上传后想让页图
真正生成出来，才需要用 `:local` 这一份跑一次转换脚本，跑完直接连本机数据库看结果。
两份 env 文件都不进 git，按 `.env.example` 各自准备。

**本机没装 LibreOffice/poppler 时会怎样**：脚本启动时先探测 `soffice` / `pdftoppm` /
`pdftotext` / `pdfinfo` 四个命令是否都能跑通，缺哪个都会在真正碰数据库或对象存储之前，
用中文报错「缺少以下命令行工具，请先安装：xxx。参见 scripts/README-report-convert.md。」
打到 stderr，然后 `process.exit(1)` 直接退出（不会认领报告、不会改任何数据库记录）。按
上面「安装依赖」补装齐了再跑即可；不想装的话，本机联调报告库时留着报告停在 `QUEUED`
也不影响列表/详情等纯读接口的开发。

## 环境变量

| 变量 | 默认值 | 作用 |
|---|---|---|
| `REPORT_CONVERT_POLL_MS` | `15000` | 没有排队中的报告时，下一次轮询前等待的毫秒数 |
| `DATABASE_URL` 等 | — | 和其他脚本共用 `@/db` 的连接配置，见 `.env.local` |

`.env.local` 需要能连到跑着报告表的那个 Postgres（本机用 homebrew postgres 或线上
Supabase 都行），以及对象存储相关的环境变量（本机走 `LocalVideoBucket`，线上走
`CosVideoBucket`，由 `getVideoBucket()` 自动判断）。

## 转换成功率的兜底顺序

1. **LibreOffice 正常转换**（PPT/PPTX → PDF，PDF 直传跳过这步）。
2. 失败（含超时、崩溃）就**换 `--infilter` 强制解析格式重试**，绕开自动探测对
   损坏/非标文件的误判——最多总共重试 3 次，每次独立 30 分钟超时，超时或崩溃就
   杀掉进程重新拉起（LibreOffice 卡死是常态，杀掉重来比等着靠谱）。
3. **字体缺失不算失败**：转换过程里出现的字体替换信息会被收进
   `reports.convert_notes`，报告库卡片不报错，工作台的来源信息里能看到。
4. 三次都失败才判定整份 **FAILED**，`fail_reason` 写人能看懂的中文原因（文件
   损坏／加密／嵌入对象无法渲染），并提示"改传 PDF"。
5. PDF 到手后逐页出图：**单页渲染失败会降级为占位、记录原因，不拖累整份**——
   该页 `render_status = FAILED`，其余页照常生成，报告仍能整体 `READY`。

## 常见失败与处置

| 现象 | 大概率原因 | 处置 |
|---|---|---|
| 启动时报"缺少以下命令行工具" | 对应命令没装或不在 `PATH` 里 | 按上面的安装清单补装，`which soffice`／`which pdftoppm` 确认路径 |
| 单份报告一直卡在 PROCESSING 不动 | 脚本进程本身挂了/被杀（比如机器重启） | 重新起一个脚本进程；`convert_attempts` 会在下次领取时继续累加，不影响正确性 |
| `fail_reason` 提示文件损坏/加密 | 原 PPT 本身有问题，或是加密文档 | 引导用户改传导出的 PDF（工作台/报告库应给出重新上传入口），走 `POST /api/reports/[id]/retry` |
| 个别页一直 `render_status = FAILED` | 该页有 soffice/pdftoppm 渲染不了的嵌入对象 | 通常是个例，不影响其余页；确实要修就让用户改传该页正常的版本重新上传 |
| 中文明显缺字、变成方块或被替换成不像的字体 | 离线机没装够中文字体，也没配 fontconfig 映射 | 按上面的字体清单补装，或者加 fontconfig 映射规则后 `fc-cache -f` |
| 235 页以上的超大策略稿转换很慢 | 页数本身多，不设页数上限，只影响耗时 | 属正常现象；报告库卡片超过 300 页会提示"页数较多，生成会慢一些" |

## 上线前的回归清单

按规格第四节末尾的验收要求，上线前至少拿这五份真实文件跑一遍，全部 `READY` 才算过：

- 红谷滩 `.ppt`
- 浦江镇 `.ppt`
- 北蔡 `.ppt`
- 两份现代 `.pptx`

每份都用 `--report <id>` 单独跑一次，观察 `pages_done` 是否稳定推进到
`page_count`、`converter_version` 是否写入、`convert_notes`/`fail_reason` 是否可读。
