"use client";

import type { ShotDraft } from "@/lib/types";
import {
  ResizableShotTableHeader,
  ShotTableColGroup,
  ShotTableWidthToolbar,
  useShotTableColumns,
} from "@/app/components/ResizableShotTable";

type ShotGroup = {
  key: string;
  name: string;
  rawName: string;
  indexes: number[];
};

function createShot(orderIndex: number, groupName: string): ShotDraft {
  return {
    id: crypto.randomUUID(),
    orderIndex,
    groupName,
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

function normalizeShots(shots: ShotDraft[]) {
  return shots.map((shot, index) => ({
    ...shot,
    orderIndex: index,
    shotNumber: String(index + 1),
  }));
}

function buildGroups(shots: ShotDraft[]): ShotGroup[] {
  const groups: ShotGroup[] = [];
  shots.forEach((shot, index) => {
    const rawName = shot.groupName.trim();
    const previous = groups.at(-1);
    if (previous && previous.rawName === rawName) {
      previous.indexes.push(index);
      return;
    }
    groups.push({
      key: `${index}-${rawName || "untitled"}`,
      rawName,
      name: rawName || `镜头组 ${groups.length + 1}`,
      indexes: [index],
    });
  });
  return groups;
}

export default function ShotGroupEditor({
  shots,
  onChange,
}: {
  shots: ShotDraft[];
  onChange: (shots: ShotDraft[]) => void;
}) {
  const groups = buildGroups(shots);
  const columnSizing = useShotTableColumns();

  function updateShot(index: number, key: keyof ShotDraft, value: string) {
    const next = [...shots];
    next[index] = { ...next[index], [key]: value };
    onChange(next);
  }

  function renameGroup(group: ShotGroup, name: string) {
    onChange(
      shots.map((shot, index) =>
        group.indexes.includes(index) ? { ...shot, groupName: name } : shot,
      ),
    );
  }

  function updateGroupComment(group: ShotGroup, value: string) {
    const firstIndex = group.indexes[0];
    onChange(
      shots.map((shot, index) =>
        group.indexes.includes(index)
          ? { ...shot, creativeComment: index === firstIndex ? value : "" }
          : shot,
      ),
    );
  }

  function addShotToGroup(group: ShotGroup) {
    const insertionIndex = group.indexes.at(-1)! + 1;
    const next = [...shots];
    next.splice(insertionIndex, 0, createShot(insertionIndex, group.name));
    onChange(normalizeShots(next));
  }

  function addGroup() {
    const groupName = `镜头组 ${groups.length + 1}`;
    onChange(normalizeShots([...shots, createShot(shots.length, groupName)]));
  }

  function duplicateShot(index: number) {
    const source = shots[index];
    const next = [...shots];
    next.splice(index + 1, 0, { ...source, id: crypto.randomUUID() });
    onChange(normalizeShots(next));
  }

  function deleteShot(index: number) {
    if (shots.length === 1) return;
    onChange(normalizeShots(shots.filter((_, itemIndex) => itemIndex !== index)));
  }

  function moveShotWithinGroup(group: ShotGroup, index: number, direction: -1 | 1) {
    const position = group.indexes.indexOf(index);
    const target = group.indexes[position + direction];
    if (target === undefined) return;
    const next = [...shots];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(normalizeShots(next));
  }

  function moveGroup(groupIndex: number, direction: -1 | 1) {
    const targetIndex = groupIndex + direction;
    if (targetIndex < 0 || targetIndex >= groups.length) return;
    const groupedShots = groups.map((group) =>
      group.indexes.map((index) => shots[index]),
    );
    [groupedShots[groupIndex], groupedShots[targetIndex]] = [
      groupedShots[targetIndex],
      groupedShots[groupIndex],
    ];
    onChange(normalizeShots(groupedShots.flat()));
  }

  return (
    <div className="shot-groups">
      <ShotTableWidthToolbar onReset={columnSizing.resetAll} />
      {groups.map((group, groupIndex) => {
        const groupComment = group.indexes
          .map((index) => shots[index].creativeComment.trim())
          .filter(Boolean)
          .join("\n\n");
        return (
          <section className="shot-group" key={group.key}>
            <header className="shot-group-head">
              <div className="shot-group-index">
                <span>镜头组</span>
                <strong>{String(groupIndex + 1).padStart(2, "0")}</strong>
              </div>
              <label className="shot-group-name">
                <span>这一组镜头在叙事中承担什么段落？</span>
                <input
                  value={group.name}
                  onChange={(event) => renameGroup(group, event.target.value)}
                  aria-label={`镜头组 ${groupIndex + 1} 名称`}
                />
              </label>
              <div className="shot-group-actions">
                <button
                  type="button"
                  onClick={() => moveGroup(groupIndex, -1)}
                  disabled={groupIndex === 0}
                  aria-label={`上移${group.name}`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => moveGroup(groupIndex, 1)}
                  disabled={groupIndex === groups.length - 1}
                  aria-label={`下移${group.name}`}
                >
                  ↓
                </button>
                <button type="button" onClick={() => addShotToGroup(group)}>
                  ＋ 本组加镜头
                </button>
              </div>
            </header>

            <div className="shot-table-scroll">
              <table
                className="shot-table"
                style={{
                  width: `${columnSizing.tableWidth}px`,
                  minWidth: `${columnSizing.tableWidth}px`,
                }}
              >
                <ShotTableColGroup widths={columnSizing.widths} />
                <ResizableShotTableHeader sizing={columnSizing} />
                <tbody>
                  {group.indexes.map((index, position) => {
                    const shot = shots[index];
                    return (
                      <tr key={shot.id}>
                        {position === 0 ? (
                          <td
                            className="shot-group-table-cell"
                            rowSpan={group.indexes.length}
                          >
                            <strong>{String(groupIndex + 1).padStart(2, "0")}</strong>
                            <span>{group.name}</span>
                          </td>
                        ) : null}
                        <td className="shot-number-cell">
                          <strong>{String(index + 1).padStart(2, "0")}</strong>
                          <div>
                            <button
                              type="button"
                              onClick={() => moveShotWithinGroup(group, index, -1)}
                              disabled={position === 0}
                              aria-label={`上移镜头 ${index + 1}`}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              onClick={() => moveShotWithinGroup(group, index, 1)}
                              disabled={position === group.indexes.length - 1}
                              aria-label={`下移镜头 ${index + 1}`}
                            >
                              ↓
                            </button>
                            <button type="button" onClick={() => duplicateShot(index)}>
                              复制
                            </button>
                            <button
                              type="button"
                              onClick={() => deleteShot(index)}
                              disabled={shots.length === 1}
                            >
                              删除
                            </button>
                          </div>
                        </td>
                        <td>
                          <label>
                            <span>开始</span>
                            <input
                              value={shot.startTime}
                              onChange={(event) =>
                                updateShot(index, "startTime", event.target.value)
                              }
                              placeholder="00:00"
                            />
                          </label>
                          <label>
                            <span>结束</span>
                            <input
                              value={shot.endTime}
                              onChange={(event) =>
                                updateShot(index, "endTime", event.target.value)
                              }
                              placeholder="00:05"
                            />
                          </label>
                        </td>
                        <td>
                          <input
                            value={shot.shotSize}
                            onChange={(event) =>
                              updateShot(index, "shotSize", event.target.value)
                            }
                            aria-label={`镜头 ${index + 1} 景别`}
                          />
                        </td>
                        <td>
                          <input
                            value={shot.cameraAngle}
                            onChange={(event) =>
                              updateShot(index, "cameraAngle", event.target.value)
                            }
                            aria-label={`镜头 ${index + 1} 机位／角度`}
                          />
                        </td>
                        <td>
                          <input
                            value={shot.cameraMovement}
                            onChange={(event) =>
                              updateShot(index, "cameraMovement", event.target.value)
                            }
                            aria-label={`镜头 ${index + 1} 镜头运动`}
                          />
                        </td>
                        <td>
                          <textarea
                            rows={8}
                            value={shot.visualContent}
                            onChange={(event) =>
                              updateShot(index, "visualContent", event.target.value)
                            }
                            aria-label={`镜头 ${index + 1} 画面内容`}
                          />
                        </td>
                        <td>
                          <textarea
                            rows={6}
                            value={shot.dialogue}
                            onChange={(event) =>
                              updateShot(index, "dialogue", event.target.value)
                            }
                            aria-label={`镜头 ${index + 1} 对白`}
                          />
                        </td>
                        <td>
                          <textarea
                            rows={6}
                            value={shot.voiceover}
                            onChange={(event) =>
                              updateShot(index, "voiceover", event.target.value)
                            }
                            aria-label={`镜头 ${index + 1} 旁白`}
                          />
                        </td>
                        <td>
                          <textarea
                            rows={6}
                            value={shot.screenText}
                            onChange={(event) =>
                              updateShot(index, "screenText", event.target.value)
                            }
                            aria-label={`镜头 ${index + 1} 字幕／屏幕文案`}
                          />
                        </td>
                        <td>
                          <textarea
                            rows={6}
                            value={shot.soundEffect}
                            onChange={(event) =>
                              updateShot(index, "soundEffect", event.target.value)
                            }
                            aria-label={`镜头 ${index + 1} 声效`}
                          />
                        </td>
                        <td>
                          <textarea
                            rows={6}
                            value={shot.music}
                            onChange={(event) =>
                              updateShot(index, "music", event.target.value)
                            }
                            aria-label={`镜头 ${index + 1} 音乐`}
                          />
                        </td>
                        {position === 0 ? (
                          <td
                            className="shot-group-comment-cell"
                            rowSpan={group.indexes.length}
                          >
                            <textarea
                              rows={Math.max(10, group.indexes.length * 5)}
                              value={groupComment}
                              onChange={(event) =>
                                updateGroupComment(group, event.target.value)
                              }
                              aria-label={`镜头组 ${groupIndex + 1} 创意点评／标注依据`}
                            />
                            <small>本栏针对整个镜头组填写。</small>
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      <button className="add-shot-group" type="button" onClick={addGroup}>
        <span>＋</span>
        新建下一个镜头组
      </button>
    </div>
  );
}
