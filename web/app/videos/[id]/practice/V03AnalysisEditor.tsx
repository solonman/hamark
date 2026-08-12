"use client";

import { annotationFields } from "@/lib/annotation-fields";
import {
  creativeGradeOptions,
  creativePathOptions,
  formationOptions,
  mainPathFields,
  mechanismChoicesFor,
  storyArchetypeOptions,
  storyReferenceOptions,
} from "@/lib/taxonomy-v0.3";
import type {
  AnnotationDraft,
  CreativePath,
  CreativeStructureDraft,
} from "@/lib/types";

function TextAreaField({
  label,
  hint,
  value,
  onChange,
  rows = 4,
  wide = false,
  targetKey,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  wide?: boolean;
  targetKey?: string;
}) {
  return (
    <label className={wide ? "editor-wide" : ""} data-edit-target={targetKey}>
      <span>{label}</span>
      <small>{hint}</small>
      <textarea rows={rows} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function ToggleList({
  options,
  values,
  disabledValue,
  limit,
  onChange,
}: {
  options: Array<{ value: string; label: string }>;
  values: string[];
  disabledValue?: string;
  limit: number;
  onChange: (values: string[]) => void;
}) {
  return (
    <div className="v03-choice-grid">
      {options.map((option) => (
        <label key={option.value} className={values.includes(option.value) ? "is-selected" : ""}>
          <input
            type="checkbox"
            checked={values.includes(option.value)}
            disabled={option.value === disabledValue || (!values.includes(option.value) && values.length >= limit)}
            onChange={() => onChange(
              values.includes(option.value)
                ? values.filter((value) => value !== option.value)
                : [...values, option.value],
            )}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

export default function V03AnalysisEditor({
  draft,
  onChange,
}: {
  draft: AnnotationDraft;
  onChange: (draft: AnnotationDraft) => void;
}) {
  const structure = draft.creativeStructure!;
  const updateStructure = (patch: Partial<CreativeStructureDraft>) =>
    onChange({ ...draft, creativeStructure: { ...structure, ...patch } });
  const optionalCodes = new Set(["A4", "A8", "B1", "B4", "B5", "B10"]);
  const optionalFields = annotationFields.filter((field) => optionalCodes.has(field.code));
  const mechanismSelectOptions = mechanismChoicesFor([
    structure.mechanismPrimary,
    ...structure.mechanismAuxiliary,
  ]);

  function updateOptionalField(code: string, answer: string) {
    onChange({
      ...draft,
      fields: draft.fields.map((field) =>
        field.code === code
          ? { ...field, answer, source: "HUMAN_ORIGINAL" }
          : field,
      ),
    });
  }

  return (
    <>
      <section className="worksheet-section" id="core">
        <div className="worksheet-section-head">
          <span>02</span>
          <div><p className="eyebrow">FULL-FILM FACTS & CORE JUDGEMENT</p><h2>全片事实与核心判断</h2></div>
          <p>先从脚本事实中得出全片结论；不再把 A1—A9、B1—B10 当作 19 道必填题。</p>
        </div>
        <div className="core-editor-grid v03-core-grid">
          <TextAreaField targetKey="core:commercial-intent" label="商业意图" hint="这支片最终要改变谁的什么认知或行为？" value={draft.commercialIntent} onChange={(value) => onChange({ ...draft, commercialIntent: value })} />
          <TextAreaField targetKey="core:story-synopsis" label="故事梗概" hint="不评价，把起点、进展和结果准确说清。" value={draft.synopsis} onChange={(value) => onChange({ ...draft, synopsis: value })} rows={5} />
          <TextAreaField targetKey="core:creative-theme" label="创意母题" hint="用一句话写出最核心的创意命题。" value={draft.creativeTheme} onChange={(value) => onChange({ ...draft, creativeTheme: value })} />
          <TextAreaField targetKey="structure:creative-button" label="创意按钮" hint="本片特有的设定、关系变化、意义判断、语言操作或视听规则是什么？" value={structure.creativeButton} onChange={(value) => updateStructure({ creativeButton: value })} rows={5} />
          <TextAreaField targetKey="structure:mechanism-statement" label="创意机制具体句" hint="先用这个案例自己的语言，写清按钮怎样产生作用。" value={structure.mechanismStatement} onChange={(value) => updateStructure({ mechanismStatement: value })} rows={5} />
          <label data-edit-target="structure:mechanism-primary">
            <span>机制二级归类</span>
            <small>在具体句之后再归类；允许判断现有词表不适用。</small>
            <select value={structure.mechanismPrimary} onChange={(event) => updateStructure({ mechanismPrimary: event.target.value, mechanismAuxiliary: structure.mechanismAuxiliary.filter((value) => value !== event.target.value) })}>
              <option value="">请选择主归类</option>
              {mechanismSelectOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
            </select>
          </label>
          <div className="editor-wide v03-inline-field" data-edit-target="structure:mechanism-auxiliary">
            <span>辅助机制（可选 0—2 项）</span>
            <ToggleList options={mechanismSelectOptions} values={structure.mechanismAuxiliary} disabledValue={structure.mechanismPrimary} limit={2} onChange={(values) => updateStructure({ mechanismAuxiliary: values })} />
          </div>
          {[structure.mechanismPrimary, ...structure.mechanismAuxiliary].some((value) => value.includes("其他") || value.includes("待形成新机制")) ? (
            <TextAreaField targetKey="structure:mechanism-custom" label="自定义／新机制说明" hint="说明现有词表为什么不适用，并给出你的命名。" value={structure.mechanismCustom} onChange={(value) => updateStructure({ mechanismCustom: value })} wide />
          ) : null}
          <TextAreaField
            targetKey="structure:creative-realization-path"
            label="创意兑现路径"
            hint="不复述情节。说明创意如何建立、累积或偏离、完成揭示或释放，并落到品牌。"
            value={structure.creativeRealizationPath || structure.realizationSkeleton}
            onChange={(value) => updateStructure({
              creativeRealizationPath: value,
              realizationSkeleton: value,
            })}
            rows={5}
          />
          <TextAreaField targetKey="structure:brand-product-landing" label="品牌／产品落点" hint="品牌或产品怎样成为这个创意的必要一部分？" value={structure.brandProductLanding} onChange={(value) => updateStructure({ brandProductLanding: value })} rows={5} />
          <TextAreaField targetKey="core:thinking-chain" label="创意思维链" hint="从商业问题到母题、按钮、机制、实现和品牌落点的完整推导。" value={draft.thinkingChain} onChange={(value) => onChange({ ...draft, thinkingChain: value })} rows={7} wide />
          <label data-edit-target="structure:story-reference-type"><span>故事参照类型</span><small>可选预设，也可直接输入新类型。</small><input list="v03-story-reference" value={structure.storyReferenceType} onChange={(event) => updateStructure({ storyReferenceType: event.target.value })} /><datalist id="v03-story-reference">{storyReferenceOptions.map((value) => <option value={value} key={value} />)}</datalist></label>
          <label data-edit-target="structure:story-archetype"><span>故事原型</span><small>允许复合、待定和开放说明。</small><input list="v03-story-archetype" value={structure.storyArchetype} onChange={(event) => updateStructure({ storyArchetype: event.target.value })} /><datalist id="v03-story-archetype">{storyArchetypeOptions.map((value) => <option value={value} key={value} />)}</datalist></label>
          <div className="editor-wide v03-formation-card" data-edit-target="structure:formation-primary">
            <span>全片形成方式</span>
            <small>判断意义以怎样的范围、次序和分布在全片中成立；不要输入镜头编号。</small>
            <div className="v03-radio-grid">{formationOptions.map((option) => <label key={option.value} className={structure.formationPrimary === option.value ? "is-selected" : ""}><input type="radio" name="formation-primary" checked={structure.formationPrimary === option.value} onChange={() => updateStructure({ formationPrimary: option.value, formationAuxiliary: structure.formationAuxiliary.filter((value) => value !== option.value) })} /><strong>{option.label}</strong><small>{option.hint}</small></label>)}</div>
            <span>辅助形成方式（可选 0—2 项）</span>
            <div data-edit-target="structure:formation-auxiliary"><ToggleList options={formationOptions.map((option) => ({ value: option.value, label: option.label }))} values={structure.formationAuxiliary} disabledValue={structure.formationPrimary} limit={2} onChange={(values) => updateStructure({ formationAuxiliary: values as CreativeStructureDraft["formationAuxiliary"] })} /></div>
            {structure.formationPrimary === "LOCAL_TRIGGER" ? <div className="v03-group-picker" data-edit-target="structure:formation-related-groups"><span>可选关键桥段（按标题选择）</span>{(draft.shotGroups ?? []).map((group) => <label key={group.id}><input type="checkbox" checked={structure.formationRelatedGroupIds.includes(group.id)} onChange={() => updateStructure({ formationRelatedGroupIds: structure.formationRelatedGroupIds.includes(group.id) ? structure.formationRelatedGroupIds.filter((id) => id !== group.id) : [...structure.formationRelatedGroupIds, group.id] })} />{group.title || "未命名桥段"}</label>)}</div> : null}
          </div>
          <TextAreaField targetKey="structure:formation-statement" label="形成说明" hint={structure.formationPrimary === "COMPOSITE" ? "用 1—3 句话说明各形成方式的分工。" : "用 1—3 句话说明创意在全片中怎样形成。"} value={structure.formationStatement} onChange={(value) => updateStructure({ formationStatement: value })} rows={5} wide />
          <TextAreaField targetKey="structure:creative-carriers" label="创意承重载体" hint="哪些故事、文案、动作、视听规则或品牌要素真正在承重？" value={structure.creativeCarriers} onChange={(value) => updateStructure({ creativeCarriers: value })} />
          <TextAreaField targetKey="structure:establishment-conditions" label="创意成立条件" hint="观众需要接受什么关系、规则或前提？" value={structure.establishmentConditions} onChange={(value) => updateStructure({ establishmentConditions: value })} />
          <TextAreaField targetKey="structure:strength-sources" label="成片强度来源" hint="这支成片的力量主要来自哪些表达层？" value={structure.strengthSources} onChange={(value) => updateStructure({ strengthSources: value })} />
          <div className="editor-wide condition-switches"><span>条件显示</span><label><input type="checkbox" checked={structure.conditionFlags.unconventionalWorld} onChange={(event) => updateStructure({ conditionFlags: { ...structure.conditionFlags, unconventionalWorld: event.target.checked } })} />存在明显非常规世界</label><label><input type="checkbox" checked={structure.conditionFlags.audiovisualCarriesIdea} onChange={(event) => updateStructure({ conditionFlags: { ...structure.conditionFlags, audiovisualCarriesIdea: event.target.checked } })} />视听规则承担创意按钮或承重载体</label><label><input type="checkbox" checked={structure.conditionFlags.interestingLoadBearing} onChange={(event) => updateStructure({ conditionFlags: { ...structure.conditionFlags, interestingLoadBearing: event.target.checked } })} />“有趣／预期组织”明显承重</label></div>
          {structure.conditionFlags.unconventionalWorld ? <TextAreaField targetKey="structure:acceptance-contract" label="成立契约" hint="这个非常规世界如何让观众愿意接受？" value={structure.acceptanceContract} onChange={(value) => updateStructure({ acceptanceContract: value })} wide /> : null}
          {structure.conditionFlags.audiovisualCarriesIdea ? <TextAreaField targetKey="structure:audiovisual-mechanism" label="视听机制具体操作" hint="不写抽象风格，写清视听规则具体怎样使创意发生。" value={structure.audiovisualMechanism} onChange={(value) => updateStructure({ audiovisualMechanism: value })} wide /> : null}
          {(structure.primaryCreativePath === "INTERESTING" || structure.conditionFlags.interestingLoadBearing) ? <TextAreaField targetKey="structure:information-release-turning" label="信息释放／转折结构" hint="写清原始预期、偏离、揭示与重释怎样被组织。" value={structure.informationReleaseTurning} onChange={(value) => updateStructure({ informationReleaseTurning: value })} wide /> : null}
          <TextAreaField targetKey="core:full-summary" label="全篇创意总结" hint="综合说明商业转译、母题、按钮、感知实现与品牌落点如何共同成立。" value={draft.summary} onChange={(value) => onChange({ ...draft, summary: value, shotCommentary: value })} rows={7} wide />
        </div>
        <details className="v03-optional-metadata">
          <summary>非阻断结构化元数据 <span>可选·不计入发布完整度</span></summary>
          <p>这些项仅用于检索与后续 AI 校验，不恢复成 19 项必填表。</p>
          <div className="v03-metadata-grid">{optionalFields.map((field) => { const answer = draft.fields.find((item) => item.code === field.code)?.answer ?? ""; return <label key={field.code} data-edit-target={`field:${field.code}:answer`}><span>{field.code} {field.name}</span><small>{field.question}</small><input list={`metadata-${field.code}`} value={answer} onChange={(event) => updateOptionalField(field.code, event.target.value)} /><datalist id={`metadata-${field.code}`}>{field.options.map((option) => <option value={option.value} key={option.value} />)}</datalist></label>; })}</div>
        </details>
      </section>

      <section className="worksheet-section" id="path">
        <div className="worksheet-section-head"><span>03</span><div><p className="eyebrow">DOMINANT CREATIVE PATH</p><h2>主导类型发生路径</h2></div><p>主导回答“拿掉后是否坍塌”；辅助回答“拿掉后是否明显变弱”。</p></div>
        <div className="v03-path-editor">
          <div data-edit-target="structure:primary-creative-path"><span>主导路径（必选 1 项）</span><div className="v03-radio-grid path">{creativePathOptions.map((option) => <label key={option.value} className={structure.primaryCreativePath === option.value ? "is-selected" : ""}><input type="radio" name="creative-path" checked={structure.primaryCreativePath === option.value} onChange={() => updateStructure({ primaryCreativePath: option.value, auxiliaryCreativePaths: structure.auxiliaryCreativePaths.filter((path) => path !== option.value) })} /><strong>{option.label}</strong></label>)}</div></div>
          <div data-edit-target="structure:auxiliary-creative-paths"><span>辅助路径（可选 0—2 项）</span><ToggleList options={creativePathOptions} values={structure.auxiliaryCreativePaths} disabledValue={structure.primaryCreativePath} limit={2} onChange={(values) => updateStructure({ auxiliaryCreativePaths: values as CreativePath[] })} /></div>
          <TextAreaField targetKey="structure:composite-state-reason" label="复合态判断" hint="说明为什么有一条主导路径，而不是三类并列。" value={structure.compositeStateReason} onChange={(value) => updateStructure({ compositeStateReason: value })} rows={5} wide />
          {structure.primaryCreativePath ? <div className="core-editor-grid v03-main-path-fields editor-wide">{mainPathFields[structure.primaryCreativePath].map((field) => <TextAreaField key={field.key} targetKey={`structure:main-path:${field.key}`} label={field.label} hint={field.hint} value={structure.mainPathPayload[field.key] ?? ""} onChange={(value) => updateStructure({ mainPathPayload: { ...structure.mainPathPayload, [field.key]: value } })} />)}</div> : <p className="v03-empty-state">选择主导路径后，系统只显示该路径的 5 个核心问题。</p>}
          {structure.auxiliaryCreativePaths.map((path) => { const label = creativePathOptions.find((option) => option.value === path)?.label ?? path; return <TextAreaField key={path} targetKey={`structure:aux-path:${path}`} label={`辅助路径·${label}`} hint="说明使用了什么辅助力量、增强了什么，以及拿掉后为什么只是变弱而不是坍塌。" value={structure.auxiliaryPathNotes[path] ?? ""} onChange={(value) => updateStructure({ auxiliaryPathNotes: { ...structure.auxiliaryPathNotes, [path]: value } })} rows={5} wide />; })}
        </div>
      </section>

      <section className="worksheet-section" id="grade">
        <div className="worksheet-section-head"><span>04</span><div><p className="eyebrow">SUBMIT & SELF-RATING</p><h2>提交与 S／A／B／C 自评</h2></div><p>评价对象是作品创意整体，不单纯评价导演执行精度。</p></div>
        <div className="v03-grade-grid">{creativeGradeOptions.map((option) => <label key={option.value} className={structure.creativeGrade === option.value ? "is-selected" : ""}><input type="radio" name="creative-grade" checked={structure.creativeGrade === option.value} onChange={() => updateStructure({ creativeGrade: option.value })} /><strong>{option.value}</strong><span>{option.description}</span></label>)}</div>
        <div className="core-editor-grid"><TextAreaField targetKey="structure:creative-grade-reason" label="自评理由" hint="写清你为什么给出这个等级。" value={structure.creativeGradeReason} onChange={(value) => updateStructure({ creativeGradeReason: value })} rows={5} wide /></div>
        <p className="v03-ai-boundary">本轮不做 AI 预填。发布后的 AI 对照分析属于 V1 之后的后续阶段，不会覆盖你的原始答案。</p>
      </section>
    </>
  );
}
