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
import { InlineAnnotationText } from "./AnalysisComments";

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
            return (
              <section
                className="submitted-shot-group"
                key={`${group.name}-${groupIndex}`}
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
                            >
                              <strong>{String(groupIndex + 1).padStart(2, "0")}</strong>
                              <small>
                                <InlineAnnotationText
                                  targetKey={`shot:${group.shots[0]?.id}:group-name`}
                                  targetLabel={`镜头组 ${String(groupIndex + 1).padStart(2, "0")} 分段与名称`}
                                  value={group.shots[0]?.groupName ?? ""}
                                  emptyText={group.name}
                                />
                              </small>
                            </td>
                          ) : null}
                          <td>
                            <strong>
                              <InlineAnnotationText
                                targetKey={`shot:${shot.id || shotIndex}:number`}
                                targetLabel={`${group.name} · 镜头序号`}
                                value={shot.shotNumber}
                              />
                            </strong>
                          </td>
                          <td className="inline-time-cell">
                            <InlineAnnotationText
                              targetKey={`shot:${shot.id || shotIndex}:start-time`}
                              targetLabel={`${group.name} · 镜头 ${shot.shotNumber} 开始时间`}
                              value={shot.startTime}
                            />
                            <span>→</span>
                            <InlineAnnotationText
                              targetKey={`shot:${shot.id || shotIndex}:end-time`}
                              targetLabel={`${group.name} · 镜头 ${shot.shotNumber} 结束时间`}
                              value={shot.endTime}
                            />
                          </td>
                          <td><InlineAnnotationText targetKey={`shot:${shot.id || shotIndex}:shot-size`} targetLabel={`${group.name} · 镜头 ${shot.shotNumber} 景别`} value={shot.shotSize} /></td>
                          <td><InlineAnnotationText targetKey={`shot:${shot.id || shotIndex}:camera-angle`} targetLabel={`${group.name} · 镜头 ${shot.shotNumber} 机位／角度`} value={shot.cameraAngle} /></td>
                          <td><InlineAnnotationText targetKey={`shot:${shot.id || shotIndex}:camera-movement`} targetLabel={`${group.name} · 镜头 ${shot.shotNumber} 镜头运动`} value={shot.cameraMovement} /></td>
                          <td><InlineAnnotationText targetKey={`shot:${shot.id || shotIndex}:visual-content`} targetLabel={`${group.name} · 镜头 ${shot.shotNumber} 画面内容`} value={shot.visualContent} /></td>
                          <td><InlineAnnotationText targetKey={`shot:${shot.id || shotIndex}:dialogue`} targetLabel={`${group.name} · 镜头 ${shot.shotNumber} 对白`} value={shot.dialogue} /></td>
                          <td><InlineAnnotationText targetKey={`shot:${shot.id || shotIndex}:voiceover`} targetLabel={`${group.name} · 镜头 ${shot.shotNumber} 旁白`} value={shot.voiceover} /></td>
                          <td><InlineAnnotationText targetKey={`shot:${shot.id || shotIndex}:screen-text`} targetLabel={`${group.name} · 镜头 ${shot.shotNumber} 字幕／文案`} value={shot.screenText} /></td>
                          <td><InlineAnnotationText targetKey={`shot:${shot.id || shotIndex}:sound-effect`} targetLabel={`${group.name} · 镜头 ${shot.shotNumber} 声效`} value={shot.soundEffect} /></td>
                          <td><InlineAnnotationText targetKey={`shot:${shot.id || shotIndex}:music`} targetLabel={`${group.name} · 镜头 ${shot.shotNumber} 音乐`} value={shot.music} /></td>
                          {shotIndex === 0 ? (
                            <td
                              className="submitted-group-comment-cell"
                              rowSpan={group.shots.length}
                            >
                              <div className="group-comment-lines">
                                {group.shots.map((groupShot) => (
                                  <div key={groupShot.id}>
                                    <small>镜头 {groupShot.shotNumber}</small>
                                    <InlineAnnotationText
                                      targetKey={`shot:${groupShot.id}:creative-comment`}
                                      targetLabel={`${group.name} · 镜头 ${groupShot.shotNumber} 创意点评`}
                                      value={groupShot.creativeComment}
                                    />
                                  </div>
                                ))}
                              </div>
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
        <div className="inline-scored-content">
          <div className="inline-scored-content-head">
            <span>商业意图</span>
            <InlineReviewScore code="commercial_intent" hideLabel />
          </div>
          <p><InlineAnnotationText targetKey="core:commercial-intent" targetLabel="商业意图" value={payload.commercialIntent} /></p>
        </div>
        <div className="inline-scored-content">
          <div className="inline-scored-content-head">
            <span>创意母题</span>
            <InlineReviewScore code="creative_theme" hideLabel />
          </div>
          <p><InlineAnnotationText targetKey="core:creative-theme" targetLabel="创意母题" value={payload.creativeTheme} /></p>
        </div>
        <div className="wide inline-scored-content">
          <div className="inline-scored-content-head">
            <span>故事梗概</span>
            <InlineReviewScore code="story_synopsis" hideLabel />
          </div>
          <p><InlineAnnotationText targetKey="core:story-synopsis" targetLabel="故事梗概" value={payload.synopsis} /></p>
        </div>
        <div className="wide inline-scored-content">
          <div className="inline-scored-content-head">
            <span>创意思维链</span>
            <InlineReviewScore code="thinking_chain" hideLabel />
          </div>
          <p><InlineAnnotationText targetKey="core:thinking-chain" targetLabel="创意思维链" value={payload.thinkingChain} /></p>
        </div>
        <div className="wide inline-scored-content">
          <div className="inline-scored-content-head">
            <span>全篇创意总结</span>
            <InlineReviewScore code="full_summary" hideLabel />
          </div>
          <p><InlineAnnotationText targetKey={payload.summary ? "core:full-summary" : "core:shot-commentary"} targetLabel="全篇创意总结" value={payload.summary || payload.shotCommentary} /></p>
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
              <div className="inline-scored-content" key={field.code}>
                <span>{field.code}</span>
                <strong>{field.name}</strong>
                <p><InlineAnnotationText targetKey={`field:${field.code}:answer`} targetLabel={`${field.code} ${field.name} · 答案`} value={answer?.answer ?? ""} /></p>
                {answer?.evidence ? <small>依据：<InlineAnnotationText targetKey={`field:${field.code}:evidence`} targetLabel={`${field.code} ${field.name} · 标注依据`} value={answer.evidence} /></small> : null}
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
              <div className="inline-scored-content" key={field.code}>
                <span>{field.code}</span>
                <strong>{field.name}</strong>
                <p><InlineAnnotationText targetKey={`field:${field.code}:answer`} targetLabel={`${field.code} ${field.name} · 答案`} value={answer?.answer ?? ""} /></p>
                {answer?.evidence ? <small>依据：<InlineAnnotationText targetKey={`field:${field.code}:evidence`} targetLabel={`${field.code} ${field.name} · 标注依据`} value={answer.evidence} /></small> : null}
                <InlineReviewScore code={`field_${field.code}`} />
              </div>
            );
          })}
        </div>
      </details>
    </>
  );
}
