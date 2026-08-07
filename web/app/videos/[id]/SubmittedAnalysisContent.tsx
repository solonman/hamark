"use client";

import { annotationFields } from "@/lib/annotation-fields";
import type { ShotDraft, SubmittedAnalysis } from "@/lib/types";
import {
  ResizableShotTableHeader,
  ShotTableColGroup,
  ShotTableWidthToolbar,
  useShotTableColumns,
} from "@/app/components/ResizableShotTable";
import {
  InlineReviewScore,
  InlineReviewScoreGroup,
} from "./ReviewPanel";

function groupSubmittedShots(shots: ShotDraft[]) {
  const groups: Array<{ name: string; shots: ShotDraft[] }> = [];
  shots.forEach((shot) => {
    const name = shot.groupName.trim() || `镜头组 ${groups.length + 1}`;
    const previous = groups.at(-1);
    if (previous?.name === name) previous.shots.push(shot);
    else groups.push({ name, shots: [shot] });
  });
  return groups;
}

function groupCreativeComment(shots: ShotDraft[]) {
  return shots
    .map((shot) => shot.creativeComment.trim())
    .filter(Boolean)
    .join("\n\n");
}

const shotScoreCodes = [
  "shot_segmentation",
  "shot_language",
  "shot_visual",
  "shot_speech",
  "shot_text",
  "shot_sound",
  "shot_music",
];

const commentaryScoreCodes = [
  "commentary_function",
  "commentary_narrative",
  "commentary_brand",
  "commentary_audiovisual",
];

export default function SubmittedAnalysisContent({
  analysis,
  forceOpen = false,
}: {
  analysis: SubmittedAnalysis;
  forceOpen?: boolean;
}) {
  const payload = analysis.payload;
  const shotGroups = groupSubmittedShots(payload.shots);
  const columnSizing = useShotTableColumns();

  return (
    <>
      <details
        className="analysis-details"
        id={`analysis-${analysis.id}-shots`}
        open={forceOpen ? true : undefined}
      >
        <summary>
          查看逐镜脚本与镜头组创意点评
          <span>
            {shotGroups.length} 个镜头组 · {payload.shots.length} 个镜头
          </span>
        </summary>
        <ShotTableWidthToolbar onReset={columnSizing.resetAll} dark />
        <div className="submitted-shot-groups">
          {shotGroups.map((group, groupIndex) => {
            const creativeComment = groupCreativeComment(group.shots);
            return (
              <section
                className="submitted-shot-group"
                key={`${group.name}-${groupIndex}`}
                data-annotation-target={`shot-group:${groupIndex}`}
                data-annotation-label={`镜头组 ${String(groupIndex + 1).padStart(2, "0")} · ${group.name}`}
              >
                <header>
                  <span>镜头组 {String(groupIndex + 1).padStart(2, "0")}</span>
                  <strong>{group.name}</strong>
                  <small>{group.shots.length} 个镜头</small>
                </header>
                <div className="submitted-shot-table-scroll">
                  <table
                    className="submitted-shot-table"
                    style={{
                      width: `${columnSizing.tableWidth}px`,
                      minWidth: `${columnSizing.tableWidth}px`,
                    }}
                  >
                    <ShotTableColGroup widths={columnSizing.widths} />
                    <ResizableShotTableHeader sizing={columnSizing} />
                    <tbody>
                      {group.shots.map((shot, shotIndex) => (
                        <tr key={shot.id || shotIndex}>
                          {shotIndex === 0 ? (
                            <td
                              className="submitted-group-table-cell"
                              rowSpan={group.shots.length}
                              data-annotation-target={`shot-group:${groupIndex}:identity`}
                              data-annotation-label={`镜头组 ${String(groupIndex + 1).padStart(2, "0")} 分段与名称`}
                            >
                              <strong>{String(groupIndex + 1).padStart(2, "0")}</strong>
                              <small>{group.name}</small>
                            </td>
                          ) : null}
                          <td
                            data-annotation-target={`shot:${shot.id || shotIndex}:number`}
                            data-annotation-label={`${group.name} · 镜头序号`}
                          >
                            <strong>{shot.shotNumber}</strong>
                          </td>
                          <td
                            data-annotation-target={`shot:${shot.id || shotIndex}:time`}
                            data-annotation-label={`${group.name} · 镜头 ${shot.shotNumber} 时间段`}
                          >
                            {shot.startTime || "—"}
                            <br />→ {shot.endTime || "—"}
                          </td>
                          <td data-annotation-target={`shot:${shot.id || shotIndex}:shot-size`} data-annotation-label={`${group.name} · 镜头 ${shot.shotNumber} 景别`}>{shot.shotSize || "—"}</td>
                          <td data-annotation-target={`shot:${shot.id || shotIndex}:camera-angle`} data-annotation-label={`${group.name} · 镜头 ${shot.shotNumber} 机位／角度`}>{shot.cameraAngle || "—"}</td>
                          <td data-annotation-target={`shot:${shot.id || shotIndex}:camera-movement`} data-annotation-label={`${group.name} · 镜头 ${shot.shotNumber} 镜头运动`}>{shot.cameraMovement || "—"}</td>
                          <td data-annotation-target={`shot:${shot.id || shotIndex}:visual-content`} data-annotation-label={`${group.name} · 镜头 ${shot.shotNumber} 画面内容`}>{shot.visualContent || "—"}</td>
                          <td data-annotation-target={`shot:${shot.id || shotIndex}:dialogue`} data-annotation-label={`${group.name} · 镜头 ${shot.shotNumber} 对白`}>{shot.dialogue || "—"}</td>
                          <td data-annotation-target={`shot:${shot.id || shotIndex}:voiceover`} data-annotation-label={`${group.name} · 镜头 ${shot.shotNumber} 旁白`}>{shot.voiceover || "—"}</td>
                          <td data-annotation-target={`shot:${shot.id || shotIndex}:screen-text`} data-annotation-label={`${group.name} · 镜头 ${shot.shotNumber} 字幕／文案`}>{shot.screenText || "—"}</td>
                          <td data-annotation-target={`shot:${shot.id || shotIndex}:sound-effect`} data-annotation-label={`${group.name} · 镜头 ${shot.shotNumber} 声效`}>{shot.soundEffect || "—"}</td>
                          <td data-annotation-target={`shot:${shot.id || shotIndex}:music`} data-annotation-label={`${group.name} · 镜头 ${shot.shotNumber} 音乐`}>{shot.music || "—"}</td>
                          {shotIndex === 0 ? (
                            <td
                              className="submitted-group-comment-cell"
                              rowSpan={group.shots.length}
                              data-annotation-target={`shot-group:${groupIndex}:creative-comment`}
                              data-annotation-label={`${group.name} · 镜头创意点评`}
                            >
                              {creativeComment || "—"}
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
        </div>
        <div className="inline-shot-review-grid">
          <InlineReviewScoreGroup
            title="逐镜脚本还原 · 35分"
            codes={shotScoreCodes}
          />
          <InlineReviewScoreGroup
            title="镜头创意点评 · 20分"
            codes={commentaryScoreCodes}
          />
        </div>
      </details>

      <div className="analysis-core-grid" id={`analysis-${analysis.id}-core`}>
        <div className="inline-scored-content" data-annotation-target="core:commercial-intent" data-annotation-label="商业意图">
          <div className="inline-scored-content-head">
            <span>商业意图</span>
            <InlineReviewScore code="commercial_intent" hideLabel />
          </div>
          <p>{payload.commercialIntent || "—"}</p>
        </div>
        <div className="inline-scored-content" data-annotation-target="core:creative-theme" data-annotation-label="创意母题">
          <div className="inline-scored-content-head">
            <span>创意母题</span>
            <InlineReviewScore code="creative_theme" hideLabel />
          </div>
          <p>{payload.creativeTheme || "—"}</p>
        </div>
        <div className="wide inline-scored-content" data-annotation-target="core:story-synopsis" data-annotation-label="故事梗概">
          <div className="inline-scored-content-head">
            <span>故事梗概</span>
            <InlineReviewScore code="story_synopsis" hideLabel />
          </div>
          <p>{payload.synopsis || "—"}</p>
        </div>
        <div className="wide inline-scored-content" data-annotation-target="core:thinking-chain" data-annotation-label="创意思维链">
          <div className="inline-scored-content-head">
            <span>创意思维链</span>
            <InlineReviewScore code="thinking_chain" hideLabel />
          </div>
          <p>{payload.thinkingChain || "—"}</p>
        </div>
        <div className="wide inline-scored-content" data-annotation-target="core:full-summary" data-annotation-label="全篇创意总结">
          <div className="inline-scored-content-head">
            <span>全篇创意总结</span>
            <InlineReviewScore code="full_summary" hideLabel />
          </div>
          <p>{payload.summary || payload.shotCommentary || "—"}</p>
        </div>
      </div>

      <details className="analysis-details" open={forceOpen ? true : undefined}>
        <summary>
          查看创意构成与故事组织 19 项专业标注
          <span>V0.2</span>
        </summary>
        <h4 className="submitted-field-heading">创意构成 9 项</h4>
        <div className="submitted-fields" id={`analysis-${analysis.id}-creative`}>
          {annotationFields.slice(0, 9).map((field) => {
            const answer = payload.fields.find((item) => item.code === field.code);
            return (
              <div className="inline-scored-content" key={field.code} data-annotation-target={`field:${field.code}`} data-annotation-label={`${field.code} ${field.name}`}>
                <span>{field.code}</span>
                <strong>{field.name}</strong>
                <p>{answer?.answer || "—"}</p>
                {answer?.evidence ? <small>依据：{answer.evidence}</small> : null}
                <InlineReviewScore code={`field_${field.code}`} />
              </div>
            );
          })}
        </div>
        <h4 className="submitted-field-heading">故事组织 10 项</h4>
        <div className="submitted-fields" id={`analysis-${analysis.id}-story`}>
          {annotationFields.slice(9).map((field) => {
            const answer = payload.fields.find((item) => item.code === field.code);
            return (
              <div className="inline-scored-content" key={field.code} data-annotation-target={`field:${field.code}`} data-annotation-label={`${field.code} ${field.name}`}>
                <span>{field.code}</span>
                <strong>{field.name}</strong>
                <p>{answer?.answer || "—"}</p>
                {answer?.evidence ? <small>依据：{answer.evidence}</small> : null}
                <InlineReviewScore code={`field_${field.code}`} />
              </div>
            );
          })}
        </div>
      </details>
    </>
  );
}
