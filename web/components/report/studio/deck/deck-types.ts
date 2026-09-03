// 报告拆解工作台第三部分（ReportDeck）对外契约。字段名与外壳 agent 约定一致，
// 改动需双方同步（见 docs/19_报告逆向工程_实施规格_V0.1.md §6.2）。

import type { CaseReviewComment } from "@/lib/case-review";
import type { ReportPageView } from "@/lib/report-model";
import type { ReportAnnotation, ReportDeckKey } from "@/lib/report-structure";
import type { ReportFinalTraceModel } from "@/lib/report-final-trace";

export type { ReportFinalFieldTrace, ReportFinalSpanTrace, ReportFinalTraceModel, ReportFinalTraceRow } from "@/lib/report-final-trace";

export type ReportDeckProps = {
  pages: ReportPageView[];
  annotation: ReportAnnotation;
  /** 看别人的版本：一切修改禁用，浮层/modal 以只读打开。 */
  readOnly: boolean;
  /** 每次变化给一个全新的不可变对象（外壳负责撤销/重做与保存）。 */
  onChange: (next: ReportAnnotation) => void;
  /**
   * 分步引导整体是否已被关掉（demo 里"引导"重开按钮在 PART 03 标题栏，由
   * 外壳渲染、外壳持久化，见 docs/demos 第 775～777 行）。不传时 deck 退回
   * 自己的内部状态（关闭后没有任何重开入口，仅供独立预览这类没有外壳标题
   * 栏的场景兜底）。
   */
  guideOff?: boolean;
  /** 用户点引导卡的 × 时调用；不传时 deck 用内部状态自己记账。 */
  onGuideOffChange?: (off: boolean) => void;
  /**
   * "定位"高亮当前指向哪个框（demo 的 `S.focus`，见第 704、738、749、758
   * 行）——受控化是为了让 `ReportMindMapButton`（跟 deck 平级、不共享内部
   * state 的兄弟组件）点节点时也能点亮左列，同 demo 第 1230～1234 行
   * `data-mindgo` 处理器里 `S.focus=key` 那一步。不传时 deck 退回自己的内部
   * state（点收纳框标题栏背景仍然能切换，只是脑图那边打不通）。
   */
  focusKey?: ReportDeckKey | null;
  /** 点收纳框标题栏背景切换"定位"时调用；不传时 deck 用内部状态自己记账。 */
  onFocusKeyChange?: (key: ReportDeckKey | null) => void;
  review: {
    /** 老孙为 true。 */
    canReview: boolean;
    /**
     * 当前正在看的版本 id（含集成版）；决定 `comments` 里哪一条是"本版"。
     * 与 `ReportPartOne`/`V19StudioDocument` 同一套评论口径（视频那边"跨版本
     * 汇总、标本版"，见 docs/20 一之 A）——评论不再是"一个条目一条、只留当前
     * 版本那条"，而是这个条目在所有版本上写过的全部评论。
     */
    currentVersionId: string;
    /** 以 targetKey 索引，值是这个条目在所有版本上的评论列表（按写入时间升序）。 */
    comments: Record<string, CaseReviewComment[]>;
    /** body 空串 = 删除写在当前版本上的那一条。 */
    onComment: (targetKey: string, targetLabel: string, body: string) => Promise<void>;
  };
  /**
   * 集成版·溯源视图开关（docs/21_报告集成版_实施规格_V0.1.md 一之 D、五、18/19）。
   * 不传或为 `false` 时 deck 的渲染与现在完全一致——`finalTrace`/`onAdopt`
   * 也就不会被读取，界面零变化（同一份验收清单第 3 条）。
   */
  traceMode?: boolean;
  /**
   * 每处内容与每个模块/单元划分的来源链——`null` 表示外壳还没算出来（或
   * 报告尚无集成版），deck 一律当没有溯源数据处理，不因为 `traceMode` 开着
   * 就报错。`fields`/`spans` 分别以评论用的 `targetKey`（`module:<id>:<field>`
   * / `unit:<id>:<field>` / `page:<n>:<field>` / `block:<id>:<field>`）与
   * 容器 key（`module:<id>` / `unit:<id>`）索引。
   */
  finalTrace?: ReportFinalTraceModel | null;
  /**
   * 老孙在溯源视图里点某个未纳入记录的「采纳这一版」——传入单元素数组
   * （`[intakeId]`），签名留数组是为了跟外壳日后可能加的"横幅全部采纳"共用
   * 同一个函数（那边会传多个 id），deck 自己只会一次传一个。不传时
   * （`traceMode` 开着但外壳还没接好）「采纳这一版」按钮不出现。
   */
  onAdopt?: (intakeIds: string[]) => Promise<void>;
};

export type ReportMindMapButtonProps = {
  annotation: ReportAnnotation;
  pages: ReportPageView[];
  /**
   * demo 的脑图头部与根节点都要秀报告标题（`S.data.title`，见 demo 第 820、
   * 822 行）——`ReportAnnotation`/`ReportPageView` 都不带这个字段，报告标题
   * 只在外壳持有的 `Report` 对象上，所以单独要一个。可选＋空串兜底，好让
   * 还没接上这个 prop 的调用点（旧的 `ReportStudioClient`）先不炸。
   */
  reportTitle?: string;
  /**
   * 点节点跳到收纳框时调用（先关脑图、滚过去，再喊这个）——demo 第
   * 1230～1234 行的 `data-mindgo` 处理器在跳转前顺手 `S.focus=key`，点亮
   * 左列对应页；这个按钮自己不持有 `ReportDeck` 的内部 state，所以要外壳
   * 把它接到 `ReportDeckProps.onFocusKeyChange` 上才能打通。不传时只关闭
   * ＋滚动，没有点亮效果（不影响脑图本身的其余行为）。
   */
  onGoTo?: (key: string) => void;
};

export type ReportReaderButtonProps = {
  pages: ReportPageView[];
  /** 预览 modal 头部标题要秀（"查看报告 · {reportTitle} · N 页"）——跟
   * `ReportMindMapButtonProps.reportTitle` 一样，`ReportPageView` 不带这个
   * 字段，报告标题只在外壳持有的 `Report` 对象上，这里必填（不像脑图那个
   * 可选＋兜底空串，没有旧调用点需要迁移）。 */
  reportTitle: string;
};
