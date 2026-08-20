"use client";

import type { V04UiDraft } from "@/lib/v04-ui-model";
import styles from "./V04Surface.module.css";

const coreTargets = [
  ["field-commercialIntent", "商业意图"], ["field-storySummary", "故事梗概"], ["field-creativeMotif", "创意母题"],
  ["field-tensionButton", "张力按钮"], ["field-primaryMechanism", "主辅机制"], ["field-creativeThinkingChain", "创意思维链"],
  ["field-storyReference", "故事参照"], ["field-carriers", "承重载体"], ["field-overallGrade", "整体创意评价"],
] as const;

export default function V04WorkspaceNavigation({ draft }: { draft: V04UiDraft }) {
  const locate = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
  return (
    <nav className={styles.workspaceNav} aria-label="公共工作稿分级导航">
      <button onClick={() => locate("module-1")}><b>第一模块</b><span>脚本反写</span></button>
      <div className={styles.navChildren}>
        {draft.shotGroups.map((group, groupIndex) => (
          <div key={group.id}><button onClick={() => locate(`group-${group.id}`)}>桥段{String(groupIndex + 1).padStart(2, "0")}</button>{group.shots.map((shot) => <button key={shot.id} onClick={() => locate(`shot-${shot.id}`)}>镜头 · {shot.id.split("-").at(-1)}</button>)}</div>
        ))}
      </div>
      <button onClick={() => locate("module-2")}><b>第二模块</b><span>全片事实与核心判断</span></button>
      <div className={styles.navChildren}>{coreTargets.map(([id, label]) => <button key={id} onClick={() => locate(id)}>{label}</button>)}</div>
      <button onClick={() => locate("module-3")}><b>第三模块</b><span>主导感知类型发生路径</span></button>
      <button onClick={() => locate("module-4")}><b>第四模块</b><span>提交</span></button>
    </nav>
  );
}
