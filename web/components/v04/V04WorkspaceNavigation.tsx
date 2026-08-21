"use client";

import { useEffect, useMemo, useState } from "react";
import type { V04UiDraft } from "@/lib/v04-ui-model";
import { locateV04Target, numberedV04Shots, V04_WORKSPACE_TARGETS } from "@/lib/v04-ui-client-state";
import styles from "./V04Surface.module.css";

const coreTargets = [
  [V04_WORKSPACE_TARGETS.commercialIntent, "商业意图"], [V04_WORKSPACE_TARGETS.storySummary, "故事梗概"], [V04_WORKSPACE_TARGETS.creativeMotif, "创意母题"],
  [V04_WORKSPACE_TARGETS.tensionButton, "张力按钮"], [V04_WORKSPACE_TARGETS.primaryMechanism, "主辅机制"], [V04_WORKSPACE_TARGETS.creativeThinkingChain, "创意思维链"],
  [V04_WORKSPACE_TARGETS.storyReference, "故事参照"], [V04_WORKSPACE_TARGETS.carriers, "承重载体"], [V04_WORKSPACE_TARGETS.carrierExplanation, "承重说明"],
  [V04_WORKSPACE_TARGETS.creativeContract, "成立契约"], [V04_WORKSPACE_TARGETS.overallGrade, "整体创意评价"], [V04_WORKSPACE_TARGETS.gradeReason, "评价理由"],
] as const;

export default function V04WorkspaceNavigation({ draft, onLocate }: { draft: V04UiDraft; onLocate?: (id: string) => void }) {
  const [activeId, setActiveId] = useState("module-1");
  const numbers = useMemo(() => new Map(numberedV04Shots(draft.shotGroups).map((item) => [item.stableId, item.displayNumber])), [draft.shotGroups]);
  const locate = (id: string) => { if (onLocate) onLocate(id); else void locateV04Target(id); };
  useEffect(() => {
    const ids = ["module-1", "module-2", "module-3", "module-4", ...draft.shotGroups.flatMap((group) => [`group-${group.id}`, ...group.shots.map((shot) => `shot-${shot.id}`)]), ...coreTargets.map(([id]) => id)];
    const nodes = ids.map((id) => document.getElementById(id)).filter((node): node is HTMLElement => Boolean(node));
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((left, right) => Math.abs(left.boundingClientRect.top - 120) - Math.abs(right.boundingClientRect.top - 120));
      if (visible[0]?.target.id) setActiveId(visible[0].target.id);
    }, { rootMargin: "-96px 0px -70% 0px", threshold: [0, .05] });
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [draft.shotGroups]);
  const navClass = (id: string) => activeId === id ? styles.navActive : undefined;
  return (
    <nav className={styles.workspaceNav} aria-label="公共工作稿分级导航">
      <button className={navClass("module-1")} onClick={() => locate("module-1")}><b>第一模块</b><span>脚本反写</span></button>
      <div className={styles.navChildren}>
        {draft.shotGroups.map((group, groupIndex) => (
          <div key={group.id}><button className={navClass(`group-${group.id}`)} onClick={() => locate(`group-${group.id}`)}>桥段{String(groupIndex + 1).padStart(2, "0")} · {group.title || "未命名"}</button>{group.shots.map((shot) => <button className={navClass(`shot-${shot.id}`)} key={shot.id} onClick={() => locate(`shot-${shot.id}`)}>镜头 {String(numbers.get(shot.id) ?? 0).padStart(2, "0")}</button>)}</div>
        ))}
      </div>
      <button className={navClass("module-2")} onClick={() => locate("module-2")}><b>第二模块</b><span>全片事实与核心判断</span></button>
      <div className={styles.navChildren}>{coreTargets.map(([id, label]) => <button className={navClass(id)} key={id} onClick={() => locate(id)}>{label}</button>)}</div>
      <button className={navClass("module-3")} onClick={() => locate("module-3")}><b>第三模块</b><span>主导感知类型发生路径</span></button>
      <button className={navClass("module-4")} onClick={() => locate("module-4")}><b>第四模块</b><span>提交</span></button>
    </nav>
  );
}
