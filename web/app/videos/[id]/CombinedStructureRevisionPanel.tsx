"use client";

import { useMemo, useState } from "react";
import {
  bridgeRoles,
  creativePathOptions,
  formationOptions,
  mainPathFields,
  mechanismChoicesFor,
} from "@/lib/taxonomy-v0.3";
import { toggleLimitedSelection } from "@/lib/selection";
import type {
  CreativePath,
  CreativeStructureDraft,
  FormationMode,
  ShotGroupDraft,
  SubmittedAnalysis,
} from "@/lib/types";

type PackageKind = "PATH" | "MECHANISM" | "FORMATION" | "GROUP";
type Change = {
  targetKey: string;
  targetLabel: string;
  valueType: "TEXT" | "SINGLE_SELECT" | "MULTI_SELECT";
  replacementText?: string;
  replacementValue?: string | string[];
};

function CheckList({
  options,
  values,
  disabledValue = "",
  limit = 2,
  onChange,
}: {
  options: Array<{ value: string; label: string }>;
  values: string[];
  disabledValue?: string;
  limit?: number | null;
  onChange: (values: string[]) => void;
}) {
  return <div className="combined-check-list">
    {options.map((option) => <label key={option.value}>
      <input
        type="checkbox"
        checked={values.includes(option.value)}
        disabled={option.value === disabledValue}
        onChange={() => onChange(toggleLimitedSelection(values, option.value, limit))}
      />
      <span>{option.label}</span>
    </label>)}
  </div>;
}

export default function CombinedStructureRevisionPanel({
  analysis,
  onSaved,
}: {
  analysis: SubmittedAnalysis;
  onSaved: () => Promise<void> | void;
}) {
  const source = analysis.payload.creativeStructure;
  const sourceGroups = analysis.payload.shotGroups ?? [];
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<PackageKind>("PATH");
  const [structure, setStructure] = useState<CreativeStructureDraft | null>(source ? structuredClone(source) : null);
  const [groups, setGroups] = useState<ShotGroupDraft[]>(() => structuredClone(sourceGroups));
  const [groupId, setGroupId] = useState(sourceGroups[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const mechanismOptions = useMemo(() => mechanismChoicesFor([
    source?.mechanismPrimary ?? "",
    ...(source?.mechanismAuxiliary ?? []),
  ]), [source]);
  if (!source || !structure) return null;

  const selectedGroup = groups.find((group) => group.id === groupId) ?? null;
  function reset() {
    setStructure(structuredClone(source!));
    setGroups(structuredClone(sourceGroups));
    setNotice("");
    setReason("");
  }
  function changes(): Change[] {
    const current = structure!;
    if (kind === "PATH") {
      const result: Change[] = [
        { targetKey: "structure:primary-creative-path", targetLabel: "主导创意路径", valueType: "SINGLE_SELECT", replacementValue: current.primaryCreativePath },
        { targetKey: "structure:auxiliary-creative-paths", targetLabel: "辅助创意路径", valueType: "MULTI_SELECT", replacementValue: current.auxiliaryCreativePaths },
        { targetKey: "structure:composite-state-reason", targetLabel: "复合态判断", valueType: "TEXT", replacementText: current.compositeStateReason },
      ];
      if (current.primaryCreativePath) {
        for (const field of mainPathFields[current.primaryCreativePath]) {
          result.push({ targetKey: `structure:main-path:${field.key}`, targetLabel: `主导路径·${field.label}`, valueType: "TEXT", replacementText: current.mainPathPayload[field.key] ?? "" });
        }
      }
      for (const path of current.auxiliaryCreativePaths) {
        result.push({ targetKey: `structure:aux-path:${path}`, targetLabel: `辅助路径·${path}`, valueType: "TEXT", replacementText: current.auxiliaryPathNotes[path] ?? "" });
      }
      return result;
    }
    if (kind === "MECHANISM") return [
      { targetKey: "structure:mechanism-primary", targetLabel: "机制主归类", valueType: "SINGLE_SELECT", replacementValue: current.mechanismPrimary },
      { targetKey: "structure:mechanism-auxiliary", targetLabel: "机制辅助归类", valueType: "MULTI_SELECT", replacementValue: current.mechanismAuxiliary },
      { targetKey: "structure:mechanism-custom", targetLabel: "自定义／新机制说明", valueType: "TEXT", replacementText: current.mechanismCustom },
      { targetKey: "structure:mechanism-statement", targetLabel: "创意机制具体句", valueType: "TEXT", replacementText: current.mechanismStatement },
    ];
    if (kind === "FORMATION") return [
      { targetKey: "structure:formation-primary", targetLabel: "全片主形成方式", valueType: "SINGLE_SELECT", replacementValue: current.formationPrimary },
      { targetKey: "structure:formation-auxiliary", targetLabel: "全片辅助形成方式", valueType: "MULTI_SELECT", replacementValue: current.formationAuxiliary },
      { targetKey: "structure:formation-related-groups", targetLabel: "关联桥段", valueType: "MULTI_SELECT", replacementValue: current.formationRelatedGroupIds },
      { targetKey: "structure:formation-statement", targetLabel: "全片形成说明", valueType: "TEXT", replacementText: current.formationStatement },
    ];
    if (!selectedGroup) return [];
    return [
      { targetKey: `group:${selectedGroup.id}:primary-role`, targetLabel: `${selectedGroup.title}·主要作用`, valueType: "SINGLE_SELECT", replacementValue: selectedGroup.primaryRole },
      { targetKey: `group:${selectedGroup.id}:auxiliary-roles`, targetLabel: `${selectedGroup.title}·辅助作用`, valueType: "MULTI_SELECT", replacementValue: selectedGroup.auxiliaryRoles },
      { targetKey: `group:${selectedGroup.id}:custom-role`, targetLabel: `${selectedGroup.title}·自定义作用`, valueType: "TEXT", replacementText: selectedGroup.customRole },
      { targetKey: `group:${selectedGroup.id}:note`, targetLabel: `${selectedGroup.title}·开放说明`, valueType: "TEXT", replacementText: selectedGroup.note },
    ];
  }

  async function save() {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch(`/api/analyses/${analysis.id}/change-sets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes: changes(), reason }),
      });
      const data = (await response.json()) as { changeSetId?: string; error?: string };
      if (!response.ok || !data.changeSetId) throw new Error(data.error || "联合修订保存失败");
      setNotice("联合修订已作为一个变更组保存到终审工作层。");
      await onSaved();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "联合修订保存失败");
    } finally {
      setBusy(false);
    }
  }

  function updateGroup(update: Partial<ShotGroupDraft>) {
    setGroups((current) => current.map((group) => group.id === groupId ? { ...group, ...update } : group));
  }

  return <div className="combined-revision-shell">
    <button type="button" className="button button-ghost compact" onClick={() => { setOpen(!open); if (!open) reset(); }}>
      {open ? "收起联合结构修订" : "联合结构修订"}
    </button>
    {open ? <section className="combined-revision-panel" aria-label="联合结构修订">
      <header>
        <div><strong>联合结构修订</strong><span>相互依赖的字段作为一个变更组保存</span></div>
        <select value={kind} onChange={(event) => { setKind(event.target.value as PackageKind); reset(); }}>
          <option value="PATH">主导路径＋路径字段</option>
          <option value="MECHANISM">主机制＋辅助机制＋说明</option>
          <option value="FORMATION">全片形成方式＋关联桥段</option>
          <option value="GROUP">桥段主作用＋辅助作用</option>
        </select>
      </header>
      {kind === "PATH" ? <div className="combined-revision-grid">
        <label><span>主导创意路径</span><select value={structure.primaryCreativePath} onChange={(event) => setStructure({ ...structure, primaryCreativePath: event.target.value as CreativePath })}><option value="">请选择</option>{creativePathOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <fieldset><legend>辅助路径（最多两项）</legend><CheckList options={creativePathOptions} values={structure.auxiliaryCreativePaths} disabledValue={structure.primaryCreativePath} onChange={(values) => setStructure({ ...structure, auxiliaryCreativePaths: values as CreativePath[] })} /></fieldset>
        <label className="wide"><span>复合态判断</span><textarea value={structure.compositeStateReason} onChange={(event) => setStructure({ ...structure, compositeStateReason: event.target.value })} /></label>
        {structure.primaryCreativePath ? mainPathFields[structure.primaryCreativePath].map((field) => <label key={field.key}><span>{field.label}</span><textarea value={structure.mainPathPayload[field.key] ?? ""} onChange={(event) => setStructure({ ...structure, mainPathPayload: { ...structure.mainPathPayload, [field.key]: event.target.value } })} /></label>) : null}
        {structure.auxiliaryCreativePaths.map((path) => <label key={path}><span>{creativePathOptions.find((item) => item.value === path)?.label}·增强作用</span><textarea value={structure.auxiliaryPathNotes[path] ?? ""} onChange={(event) => setStructure({ ...structure, auxiliaryPathNotes: { ...structure.auxiliaryPathNotes, [path]: event.target.value } })} /></label>)}
      </div> : null}
      {kind === "MECHANISM" ? <div className="combined-revision-grid">
        <label><span>机制主归类</span><select value={structure.mechanismPrimary} onChange={(event) => setStructure({ ...structure, mechanismPrimary: event.target.value })}><option value="">请选择</option>{mechanismOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <fieldset><legend>机制辅助归类</legend><CheckList options={mechanismOptions} values={structure.mechanismAuxiliary} disabledValue={structure.mechanismPrimary} onChange={(values) => setStructure({ ...structure, mechanismAuxiliary: values })} /></fieldset>
        <label><span>自定义／新机制说明</span><textarea value={structure.mechanismCustom} onChange={(event) => setStructure({ ...structure, mechanismCustom: event.target.value })} /></label>
        <label><span>创意机制具体句</span><textarea value={structure.mechanismStatement} onChange={(event) => setStructure({ ...structure, mechanismStatement: event.target.value })} /></label>
      </div> : null}
      {kind === "FORMATION" ? <div className="combined-revision-grid">
        <label><span>全片主形成方式</span><select value={structure.formationPrimary} onChange={(event) => setStructure({ ...structure, formationPrimary: event.target.value as FormationMode })}><option value="">请选择</option>{formationOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <fieldset><legend>辅助形成方式</legend><CheckList options={formationOptions} values={structure.formationAuxiliary} disabledValue={structure.formationPrimary} onChange={(values) => setStructure({ ...structure, formationAuxiliary: values as FormationMode[] })} /></fieldset>
        <fieldset><legend>关联桥段</legend><CheckList options={sourceGroups.map((group) => ({ value: group.id, label: group.title }))} values={structure.formationRelatedGroupIds} limit={null} onChange={(values) => setStructure({ ...structure, formationRelatedGroupIds: values })} /></fieldset>
        <label><span>全片形成说明</span><textarea value={structure.formationStatement} onChange={(event) => setStructure({ ...structure, formationStatement: event.target.value })} /></label>
      </div> : null}
      {kind === "GROUP" && selectedGroup ? <div className="combined-revision-grid">
        <label><span>选择桥段</span><select value={groupId} onChange={(event) => setGroupId(event.target.value)}>{groups.map((group) => <option key={group.id} value={group.id}>{group.title}</option>)}</select></label>
        <label><span>主要作用</span><select value={selectedGroup.primaryRole} onChange={(event) => updateGroup({ primaryRole: event.target.value })}><option value="">请选择</option>{bridgeRoles.map((role) => <option key={role} value={role}>{role}</option>)}<option value="__CUSTOM__">其他／自定义</option></select></label>
        <fieldset><legend>辅助作用</legend><CheckList options={bridgeRoles.map((role) => ({ value: role, label: role }))} values={selectedGroup.auxiliaryRoles} disabledValue={selectedGroup.primaryRole} onChange={(values) => updateGroup({ auxiliaryRoles: values })} /></fieldset>
        <label><span>自定义作用</span><textarea value={selectedGroup.customRole} onChange={(event) => updateGroup({ customRole: event.target.value })} /></label>
        <label><span>开放说明</span><textarea value={selectedGroup.note} onChange={(event) => updateGroup({ note: event.target.value })} /></label>
      </div> : null}
      <footer>
        <label><span>共同原因（选填）</span><input value={reason} onChange={(event) => setReason(event.target.value)} /></label>
        <button type="button" className="button button-accent compact" disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : "保存联合修订"}</button>
      </footer>
      {notice ? <p className="analysis-comment-notice">{notice}</p> : null}
    </section> : null}
  </div>;
}
