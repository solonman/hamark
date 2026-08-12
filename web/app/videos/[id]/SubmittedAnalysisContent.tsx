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
import {
  creativeGradeOptions,
  creativePathOptions,
  formationOptions,
  mainPathFields,
} from "@/lib/taxonomy-v0.3";
import type { CreativePath } from "@/lib/types";

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

  if (analysis.taxonomyVersion === "V0.3-PILOT") {
    return (
      <SubmittedV03Analysis
        analysis={analysis}
        forceOpen={forceOpen}
        columnSizing={columnSizing}
      />
    );
  }

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

function SubmittedV03Analysis({
  analysis,
  forceOpen,
  columnSizing,
}: {
  analysis: SubmittedAnalysis;
  forceOpen: boolean;
  columnSizing: ReturnType<typeof useShotTableColumns>;
}) {
  const payload = analysis.payload;
  const structure = payload.creativeStructure;
  const groups = payload.shotGroups ?? [];
  if (!structure) {
    return <p className="v03-empty-state">这份 V0.3 快照缺少创意结构数据，请联系管理员核验。</p>;
  }
  const pathLabel = (path: string) =>
    creativePathOptions.find((option) => option.value === path)?.label ?? path;
  const formationLabel = (mode: string) =>
    formationOptions.find((option) => option.value === mode)?.label ?? mode;
  const showValue = (targetKey: string, label: string, value: string) => (
    <InlineAnnotationText
      targetKey={targetKey}
      targetLabel={label}
      value={value}
      emptyText="未填写"
    />
  );

  return (
    <>
      <div className="v03-submission-banner">
        <strong>V0.3-PILOT 人工原始答案</strong>
        <span>工作流 REVERSE-WORKFLOW-V0.3-PILOT</span>
        <span>可原位批注；不套用 V0.2 的 RUBRIC-V0.4</span>
      </div>
      <details className="analysis-details" open={forceOpen ? true : undefined}>
        <summary>
          01 脚本反写与桥段创意作用
          <span>{groups.length} 个桥段 · {payload.shots.length} 个镜头</span>
        </summary>
        <ShotTableWidthToolbar onReset={columnSizing.resetAll} dark />
        <div className="submitted-shot-groups">
          {groups.map((group, groupIndex) => {
            const groupShots = payload.shots.filter((shot) => shot.shotGroupId === group.id);
            return (
              <section className="submitted-shot-group" key={group.id}>
                <header>
                  <span>桥段 {String(groupIndex + 1).padStart(2, "0")}</span>
                  <strong>{showValue(`group:${group.id}:title`, `桥段 ${groupIndex + 1} 标题`, group.title)}</strong>
                  <small>{groupShots.length} 个镜头</small>
                </header>
                <div className="submitted-shot-table-scroll">
                  <table className="submitted-shot-table" style={{ width: `${columnSizing.tableWidth}px`, minWidth: `${columnSizing.tableWidth}px` }}>
                    <ShotTableColGroup widths={columnSizing.widths} />
                    <ResizableShotTableHeader sizing={columnSizing} commentLabel="桥段创意作用" />
                    <tbody>
                      {groupShots.map((shot, shotIndex) => (
                        <tr key={shot.id}>
                          {shotIndex === 0 ? <td className="submitted-group-table-cell" rowSpan={groupShots.length}><strong>{String(groupIndex + 1).padStart(2, "0")}</strong><small>{group.title}</small></td> : null}
                          <td><strong><InlineAnnotationText targetKey={`shot:${shot.id}:number`} targetLabel={`${group.title} · 镜头序号`} value={shot.shotNumber} /></strong></td>
                          <td className="inline-time-cell"><InlineAnnotationText targetKey={`shot:${shot.id}:start-time`} targetLabel={`${group.title} · 开始时间`} value={shot.startTime} emptyText="未记时码" /><span>→</span><InlineAnnotationText targetKey={`shot:${shot.id}:end-time`} targetLabel={`${group.title} · 结束时间`} value={shot.endTime} emptyText="未记时码" /></td>
                          <td><InlineAnnotationText targetKey={`shot:${shot.id}:shot-size`} targetLabel={`${group.title} · 景别`} value={shot.shotSize} /></td>
                          <td><InlineAnnotationText targetKey={`shot:${shot.id}:camera-angle`} targetLabel={`${group.title} · 机位／角度`} value={shot.cameraAngle} /></td>
                          <td><InlineAnnotationText targetKey={`shot:${shot.id}:camera-movement`} targetLabel={`${group.title} · 镜头运动`} value={shot.cameraMovement} /></td>
                          <td><InlineAnnotationText targetKey={`shot:${shot.id}:visual-content`} targetLabel={`${group.title} · 画面内容`} value={shot.visualContent} /></td>
                          <td><InlineAnnotationText targetKey={`shot:${shot.id}:dialogue`} targetLabel={`${group.title} · 对白`} value={shot.dialogue} /></td>
                          <td><InlineAnnotationText targetKey={`shot:${shot.id}:voiceover`} targetLabel={`${group.title} · 旁白`} value={shot.voiceover} /></td>
                          <td><InlineAnnotationText targetKey={`shot:${shot.id}:screen-text`} targetLabel={`${group.title} · 字幕／文案`} value={shot.screenText} /></td>
                          <td><InlineAnnotationText targetKey={`shot:${shot.id}:sound-effect`} targetLabel={`${group.title} · 声效`} value={shot.soundEffect} /></td>
                          <td><InlineAnnotationText targetKey={`shot:${shot.id}:music`} targetLabel={`${group.title} · 音乐`} value={shot.music} /></td>
                          {shotIndex === 0 ? (
                            <td className="submitted-group-comment-cell" rowSpan={groupShots.length}>
                              <div className="bridge-role-summary"><strong>{group.primaryRole === "__CUSTOM__" ? group.customRole : group.primaryRole}</strong>{group.auxiliaryRoles.map((role) => <span key={role}>{role}</span>)}</div>
                              <p>{showValue(`group:${group.id}:note`, `${group.title} · 桥段创意作用说明`, group.note)}</p>
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
      </details>

      <section className="v03-submitted-section">
        <header><span>02</span><div><strong>全片事实与核心判断</strong><small>人工核心字段与条件显示字段</small></div></header>
        <div className="analysis-core-grid v03-submitted-core">
          <V03ReadCard label="商业意图" target="core:commercial-intent" value={payload.commercialIntent} />
          <V03ReadCard label="故事梗概" target="core:story-synopsis" value={payload.synopsis} />
          <V03ReadCard label="创意母题" target="core:creative-theme" value={payload.creativeTheme} />
          <V03ReadCard label="创意按钮" target="structure:creative-button" value={structure.creativeButton} />
          <V03ReadCard label="创意机制具体句" target="structure:mechanism-statement" value={structure.mechanismStatement} />
          <V03ReadCard label="机制二级归类" value={[structure.mechanismPrimary, ...structure.mechanismAuxiliary].filter(Boolean).join(" · ")} />
          {structure.mechanismCustom ? <V03ReadCard label="自定义／新机制" target="structure:mechanism-custom" value={structure.mechanismCustom} /> : null}
          <V03ReadCard
            label="创意兑现路径"
            target="structure:creative-realization-path"
            value={structure.creativeRealizationPath || structure.realizationSkeleton}
          />
          <V03ReadCard label="品牌／产品落点" target="structure:brand-product-landing" value={structure.brandProductLanding} />
          <V03ReadCard label="创意思维链" target="core:thinking-chain" value={payload.thinkingChain} wide />
          <V03ReadCard label="故事参照类型" target="structure:story-reference-type" value={structure.storyReferenceType} />
          <V03ReadCard label="故事原型" target="structure:story-archetype" value={structure.storyArchetype} />
          <V03ReadCard label="创意如何形成" value={[formationLabel(structure.formationPrimary), ...structure.formationAuxiliary.map(formationLabel)].filter(Boolean).join(" · ")} />
          <V03ReadCard label="形成说明" target="structure:formation-statement" value={structure.formationStatement} wide />
          <V03ReadCard label="创意承重载体" target="structure:creative-carriers" value={structure.creativeCarriers} />
          <V03ReadCard label="创意成立条件" target="structure:establishment-conditions" value={structure.establishmentConditions} />
          <V03ReadCard label="成片强度来源" target="structure:strength-sources" value={structure.strengthSources} />
          {structure.acceptanceContract ? <V03ReadCard label="成立契约" target="structure:acceptance-contract" value={structure.acceptanceContract} /> : null}
          {structure.audiovisualMechanism ? <V03ReadCard label="视听机制具体操作" target="structure:audiovisual-mechanism" value={structure.audiovisualMechanism} wide /> : null}
          {structure.informationReleaseTurning ? <V03ReadCard label="信息释放／转折结构" target="structure:information-release-turning" value={structure.informationReleaseTurning} wide /> : null}
          <V03ReadCard label="全篇创意总结" target="core:full-summary" value={payload.summary} wide />
        </div>
      </section>

      <section className="v03-submitted-section">
        <header><span>03</span><div><strong>主导类型发生路径</strong><small>主导 {pathLabel(structure.primaryCreativePath)}{structure.auxiliaryCreativePaths.length ? ` · 辅助 ${structure.auxiliaryCreativePaths.map(pathLabel).join("／")}` : ""}</small></div></header>
        <div className="analysis-core-grid v03-submitted-core">
          <V03ReadCard label="复合态判断" target="structure:composite-state-reason" value={structure.compositeStateReason} wide />
          {structure.primaryCreativePath ? mainPathFields[structure.primaryCreativePath].map((field) => <V03ReadCard key={field.key} label={field.label} target={`structure:main-path:${field.key}`} value={structure.mainPathPayload[field.key] ?? ""} />) : null}
          {structure.auxiliaryCreativePaths.map((path) => <V03ReadCard key={path} label={`辅助·${pathLabel(path)}`} target={`structure:aux-path:${path}`} value={structure.auxiliaryPathNotes[path as CreativePath] ?? ""} wide />)}
        </div>
      </section>

      <section className="v03-submitted-section v03-grade-result">
        <header><span>04</span><div><strong>作品创意自评</strong><small>{structure.creativeGradeVersion}</small></div></header>
        <div className="grade-mark">{structure.creativeGrade}</div>
        <div><p><InlineAnnotationText targetKey="structure:creative-grade-reason" targetLabel="创意自评理由" value={structure.creativeGradeReason} /></p><small>{creativeGradeOptions.find((option) => option.value === structure.creativeGrade)?.description}</small></div>
      </section>

      <V03Metadata payload={payload} />
    </>
  );
}

function V03ReadCard({ label, value, target, wide = false }: { label: string; value: string; target?: string; wide?: boolean }) {
  return <div className={`${wide ? "wide " : ""}inline-scored-content v03-read-card`}><div className="inline-scored-content-head"><span>{label}</span></div><p>{target ? <InlineAnnotationText targetKey={target} targetLabel={label} value={value} /> : value || "未填写"}</p></div>;
}

function V03Metadata({ payload }: { payload: SubmittedAnalysis["payload"] }) {
  const values = payload.fields.filter((field) => field.answer.trim());
  if (!values.length) return null;
  return <details className="analysis-details v03-metadata-read"><summary>非阻断结构化元数据 <span>{values.length} 项</span></summary><div className="submitted-fields">{values.map((answer) => { const definition = annotationFields.find((field) => field.code === answer.code); return <div key={answer.code}><span>{answer.code}</span><strong>{definition?.name}</strong><p><InlineAnnotationText targetKey={`field:${answer.code}:answer`} targetLabel={`${answer.code} ${definition?.name}`} value={answer.answer} /></p><small>来源：{answer.source ?? "HUMAN_ORIGINAL"}</small></div>; })}</div></details>;
}
