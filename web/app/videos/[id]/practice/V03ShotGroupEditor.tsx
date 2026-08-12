"use client";

import type { ShotDraft, ShotGroupDraft } from "@/lib/types";
import { bridgeRoleGroups } from "@/lib/taxonomy-v0.3";
import {
  ResizableShotTableHeader,
  ShotTableColGroup,
  ShotTableWidthToolbar,
  useShotTableColumns,
} from "@/app/components/ResizableShotTable";

function createShot(orderIndex: number, group: ShotGroupDraft): ShotDraft {
  return {
    id: crypto.randomUUID(),
    orderIndex,
    groupName: group.title,
    shotGroupId: group.id,
    shotNumber: String(orderIndex + 1),
    startTime: "",
    endTime: "",
    shotSize: "",
    cameraAngle: "",
    cameraMovement: "",
    visualContent: "",
    dialogue: "",
    voiceover: "",
    screenText: "",
    soundEffect: "",
    music: "",
    creativeComment: "",
  };
}

function normalizeShots(shots: ShotDraft[], groups: ShotGroupDraft[]) {
  const groupMap = new Map(groups.map((group) => [group.id, group]));
  return shots.map((shot, index) => ({
    ...shot,
    orderIndex: index,
    shotNumber: String(index + 1),
    groupName: shot.shotGroupId ? groupMap.get(shot.shotGroupId)?.title ?? "" : "",
  }));
}

export default function V03ShotGroupEditor({
  groups,
  shots,
  onChange,
}: {
  groups: ShotGroupDraft[];
  shots: ShotDraft[];
  onChange: (groups: ShotGroupDraft[], shots: ShotDraft[]) => void;
}) {
  const columnSizing = useShotTableColumns();

  function updateGroup(id: string, patch: Partial<ShotGroupDraft>) {
    const nextGroups = groups.map((group) =>
      group.id === id ? { ...group, ...patch } : group,
    );
    onChange(nextGroups, normalizeShots(shots, nextGroups));
  }

  function updateShot(id: string, key: keyof ShotDraft, value: string) {
    onChange(
      groups,
      shots.map((shot) => (shot.id === id ? { ...shot, [key]: value } : shot)),
    );
  }

  function addShot(group: ShotGroupDraft) {
    const indexes = shots
      .map((shot, index) => (shot.shotGroupId === group.id ? index : -1))
      .filter((index) => index >= 0);
    const insertionIndex = indexes.length ? indexes.at(-1)! + 1 : shots.length;
    const next = [...shots];
    next.splice(insertionIndex, 0, createShot(insertionIndex, group));
    onChange(groups, normalizeShots(next, groups));
  }

  function addGroup() {
    const group: ShotGroupDraft = {
      id: crypto.randomUUID(),
      orderIndex: groups.length,
      title: `桥段 ${groups.length + 1}`,
      primaryRole: "",
      auxiliaryRoles: [],
      customRole: "",
      note: "",
    };
    const nextGroups = [...groups, group];
    onChange(nextGroups, normalizeShots([...shots, createShot(shots.length, group)], nextGroups));
  }

  function moveGroup(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= groups.length) return;
    const nextGroups = [...groups];
    [nextGroups[index], nextGroups[target]] = [nextGroups[target], nextGroups[index]];
    const orderedGroups = nextGroups.map((group, orderIndex) => ({ ...group, orderIndex }));
    const nextShots = orderedGroups.flatMap((group) =>
      shots.filter((shot) => shot.shotGroupId === group.id),
    );
    onChange(orderedGroups, normalizeShots(nextShots, orderedGroups));
  }

  function moveShot(group: ShotGroupDraft, shotId: string, direction: -1 | 1) {
    const indexes = shots
      .map((shot, index) => (shot.shotGroupId === group.id ? index : -1))
      .filter((index) => index >= 0);
    const position = indexes.findIndex((index) => shots[index].id === shotId);
    const target = indexes[position + direction];
    if (target === undefined) return;
    const current = indexes[position];
    const next = [...shots];
    [next[current], next[target]] = [next[target], next[current]];
    onChange(groups, normalizeShots(next, groups));
  }

  function duplicateShot(shotId: string) {
    const index = shots.findIndex((shot) => shot.id === shotId);
    if (index < 0) return;
    const next = [...shots];
    next.splice(index + 1, 0, { ...shots[index], id: crypto.randomUUID() });
    onChange(groups, normalizeShots(next, groups));
  }

  function deleteShot(shotId: string) {
    if (shots.length === 1) return;
    onChange(groups, normalizeShots(shots.filter((shot) => shot.id !== shotId), groups));
  }

  return (
    <div className="shot-groups v03-shot-groups">
      <ShotTableWidthToolbar onReset={columnSizing.resetAll} />
      {groups.map((group, groupIndex) => {
        const groupShots = shots.filter((shot) => shot.shotGroupId === group.id);
        return (
          <section className="shot-group" key={group.id}>
            <header className="shot-group-head v03-group-head">
              <div className="shot-group-index">
                <span>桥段</span>
                <strong>{String(groupIndex + 1).padStart(2, "0")}</strong>
              </div>
              <label className="shot-group-name">
                <span>桥段标题</span>
                <input
                  data-edit-target={`group:${group.id}:title`}
                  value={group.title}
                  onChange={(event) => updateGroup(group.id, { title: event.target.value })}
                  aria-label={`桥段 ${groupIndex + 1} 标题`}
                />
              </label>
              <div className="shot-group-actions">
                <button type="button" onClick={() => moveGroup(groupIndex, -1)} disabled={groupIndex === 0}>↑</button>
                <button type="button" onClick={() => moveGroup(groupIndex, 1)} disabled={groupIndex === groups.length - 1}>↓</button>
                <button type="button" onClick={() => addShot(group)}>＋ 本桥段加镜头</button>
              </div>
              <div className="bridge-role-editor">
                <label data-edit-target={`group:${group.id}:primary-role`}>
                  <span>主创意作用（必选 1 项）</span>
                  <select
                    value={group.primaryRole}
                    onChange={(event) => {
                      const primaryRole = event.target.value;
                      updateGroup(group.id, {
                        primaryRole,
                        auxiliaryRoles: group.auxiliaryRoles.filter((role) => role !== primaryRole),
                      });
                    }}
                  >
                    <option value="">请选择</option>
                    {bridgeRoleGroups.map((roleGroup) => (
                      <optgroup label={roleGroup.label} key={roleGroup.label}>
                        {roleGroup.options.map((role) => <option value={role} key={role}>{role}</option>)}
                      </optgroup>
                    ))}
                    <option value="__CUSTOM__">其他（自定义）</option>
                  </select>
                </label>
                <div data-edit-target={`group:${group.id}:auxiliary-roles`}>
                  <span>辅助作用（可选 0—2 项）</span>
                  <div className="bridge-role-options">
                    {bridgeRoleGroups.flatMap((roleGroup) => roleGroup.options).map((role) => (
                      <label key={role}>
                        <input
                          type="checkbox"
                          checked={group.auxiliaryRoles.includes(role)}
                          disabled={role === group.primaryRole || (!group.auxiliaryRoles.includes(role) && group.auxiliaryRoles.length >= 2)}
                          onChange={() => updateGroup(group.id, {
                            auxiliaryRoles: group.auxiliaryRoles.includes(role)
                              ? group.auxiliaryRoles.filter((item) => item !== role)
                              : [...group.auxiliaryRoles, role],
                          })}
                        />
                        {role}
                      </label>
                    ))}
                  </div>
                </div>
                {group.primaryRole === "__CUSTOM__" ? (
                  <label data-edit-target={`group:${group.id}:custom-role`}>
                    <span>自定义作用</span>
                    <input value={group.customRole} onChange={(event) => updateGroup(group.id, { customRole: event.target.value })} />
                  </label>
                ) : null}
              </div>
            </header>

            <div className="shot-table-scroll">
              <table className="shot-table" style={{ width: `${columnSizing.tableWidth}px`, minWidth: `${columnSizing.tableWidth}px` }}>
                <ShotTableColGroup widths={columnSizing.widths} />
                <ResizableShotTableHeader sizing={columnSizing} commentLabel="桥段创意作用" />
                <tbody>
                  {groupShots.map((shot, position) => (
                    <tr key={shot.id}>
                      {position === 0 ? (
                        <td className="shot-group-table-cell" rowSpan={Math.max(1, groupShots.length)}>
                          <strong>{String(groupIndex + 1).padStart(2, "0")}</strong>
                          <span>{group.title}</span>
                        </td>
                      ) : null}
                      <td className="shot-number-cell">
                        <strong>{String(shot.orderIndex + 1).padStart(2, "0")}</strong>
                        <div>
                          <button type="button" onClick={() => moveShot(group, shot.id, -1)} disabled={position === 0}>↑</button>
                          <button type="button" onClick={() => moveShot(group, shot.id, 1)} disabled={position === groupShots.length - 1}>↓</button>
                          <button type="button" onClick={() => duplicateShot(shot.id)}>复制</button>
                          <button type="button" onClick={() => deleteShot(shot.id)} disabled={shots.length === 1}>删除</button>
                        </div>
                      </td>
                      <td>
                        <label data-edit-target={`shot:${shot.id}:start-time`}><span>开始（可选）</span><input value={shot.startTime} onChange={(event) => updateShot(shot.id, "startTime", event.target.value)} placeholder="00:00" /></label>
                        <label data-edit-target={`shot:${shot.id}:end-time`}><span>结束（可选）</span><input value={shot.endTime} onChange={(event) => updateShot(shot.id, "endTime", event.target.value)} placeholder="00:05" /></label>
                      </td>
                      <td data-edit-target={`shot:${shot.id}:shot-size`}><input value={shot.shotSize} onChange={(event) => updateShot(shot.id, "shotSize", event.target.value)} aria-label={`镜头 ${shot.orderIndex + 1} 景别`} /></td>
                      <td data-edit-target={`shot:${shot.id}:camera-angle`}><input value={shot.cameraAngle} onChange={(event) => updateShot(shot.id, "cameraAngle", event.target.value)} aria-label={`镜头 ${shot.orderIndex + 1} 机位／角度`} /></td>
                      <td data-edit-target={`shot:${shot.id}:camera-movement`}><input value={shot.cameraMovement} onChange={(event) => updateShot(shot.id, "cameraMovement", event.target.value)} aria-label={`镜头 ${shot.orderIndex + 1} 镜头运动`} /></td>
                      <td data-edit-target={`shot:${shot.id}:visual-content`}><textarea rows={8} value={shot.visualContent} onChange={(event) => updateShot(shot.id, "visualContent", event.target.value)} aria-label={`镜头 ${shot.orderIndex + 1} 画面内容`} /></td>
                      <td data-edit-target={`shot:${shot.id}:dialogue`}><textarea rows={6} value={shot.dialogue} onChange={(event) => updateShot(shot.id, "dialogue", event.target.value)} aria-label={`镜头 ${shot.orderIndex + 1} 对白`} /></td>
                      <td data-edit-target={`shot:${shot.id}:voiceover`}><textarea rows={6} value={shot.voiceover} onChange={(event) => updateShot(shot.id, "voiceover", event.target.value)} aria-label={`镜头 ${shot.orderIndex + 1} 旁白`} /></td>
                      <td data-edit-target={`shot:${shot.id}:screen-text`}><textarea rows={6} value={shot.screenText} onChange={(event) => updateShot(shot.id, "screenText", event.target.value)} aria-label={`镜头 ${shot.orderIndex + 1} 字幕／文案`} /></td>
                      <td data-edit-target={`shot:${shot.id}:sound-effect`}><textarea rows={6} value={shot.soundEffect} onChange={(event) => updateShot(shot.id, "soundEffect", event.target.value)} aria-label={`镜头 ${shot.orderIndex + 1} 声效`} /></td>
                      <td data-edit-target={`shot:${shot.id}:music`}><textarea rows={6} value={shot.music} onChange={(event) => updateShot(shot.id, "music", event.target.value)} aria-label={`镜头 ${shot.orderIndex + 1} 音乐`} /></td>
                      {position === 0 ? (
                        <td className="shot-group-comment-cell" rowSpan={Math.max(1, groupShots.length)} data-edit-target={`group:${group.id}:note`}>
                          <div className="bridge-role-summary">
                            <strong>{group.primaryRole === "__CUSTOM__" ? group.customRole || "待补充自定义作用" : group.primaryRole || "待选主作用"}</strong>
                            {group.auxiliaryRoles.map((role) => <span key={role}>{role}</span>)}
                          </div>
                          <textarea rows={Math.max(8, groupShots.length * 4)} value={group.note} onChange={(event) => updateGroup(group.id, { note: event.target.value })} aria-label={`桥段 ${groupIndex + 1} 创意作用说明`} placeholder="用开放说明写清：这个桥段为整片创意做了什么。" />
                          <small>主标签、辅助标签与说明都绑定这个桥段。</small>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
      <button className="add-shot-group" type="button" onClick={addGroup}><span>＋</span>新建下一个桥段</button>
    </div>
  );
}
