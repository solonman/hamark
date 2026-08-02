"use client";

import { useRef } from "react";
import type { AnnotationFieldDefinition } from "@/lib/annotation-fields";

type Props = {
  field: AnnotationFieldDefinition;
  answer: string;
  evidence: string;
  onAnswerChange: (value: string) => void;
  onEvidenceChange: (value: string) => void;
};

function answerParts(answer: string) {
  return answer
    .split(/[；\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function appendAnswer(answer: string, value: string) {
  const current = answer.trim();
  if (!current) return value;
  return `${current}${current.endsWith("；") ? "" : "；"}${value}`;
}

function toggleAnswer(answer: string, value: string) {
  const parts = answerParts(answer);
  if (parts.includes(value)) {
    return parts.filter((part) => part !== value).join("；");
  }
  return appendAnswer(answer, value);
}

export default function TaxonomyFieldEditor({
  field,
  answer,
  evidence,
  onAnswerChange,
  onEvidenceChange,
}: Props) {
  const answerRef = useRef<HTMLTextAreaElement>(null);
  const selectedValues = new Set(answerParts(answer));
  const groupedOptions = new Map<string, typeof field.options>();
  field.options.forEach((option) => {
    if (option.category === "开放项") return;
    const items = groupedOptions.get(option.category) ?? [];
    items.push(option);
    groupedOptions.set(option.category, items);
  });
  const categories = [...groupedOptions.entries()];
  const openOption = field.options.find(
    (option) => option.category === "开放项",
  );

  function startCustomAnswer() {
    const hasCustomEntry = answerParts(answer).some((part) =>
      part.startsWith("其他："),
    );
    if (!hasCustomEntry) onAnswerChange(appendAnswer(answer, "其他："));
    window.requestAnimationFrame(() => {
      const textarea = answerRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  }

  return (
    <article>
      <div className="taxonomy-code">{field.code}</div>
      <div className="taxonomy-copy">
        <h3>{field.name}</h3>
        <p>{field.question}</p>
        <small>{field.rule}</small>
      </div>
      <div className="taxonomy-answer">
        <div className="taxonomy-answer-head">
          <span>我的判断</span>
          <div className="taxonomy-presets">
            <button
              type="button"
              className="taxonomy-preset-trigger"
              aria-label={`${field.code} ${field.name} V0.2预设选项`}
            >
              V0.2 预设选项
              <span aria-hidden="true">＋</span>
            </button>
            <div className="taxonomy-preset-popover" role="dialog">
              <div className="taxonomy-preset-heading">
                <div>
                  <span>{field.code}</span>
                  <strong>{field.name}</strong>
                </div>
                <small>点击加入；再次点击取消</small>
              </div>
              <p className="taxonomy-preset-rule">{field.rule}</p>
              <div className="taxonomy-preset-scroll">
                {categories.map(([category, options]) => (
                  <section key={category} className="taxonomy-preset-group">
                    <h4>{category}</h4>
                    <div>
                      {options.map((option) => {
                        const selected = selectedValues.has(option.value);
                        return (
                          <button
                            type="button"
                            className={selected ? "is-selected" : ""}
                            aria-pressed={selected}
                            key={option.value}
                            onClick={() =>
                              onAnswerChange(toggleAnswer(answer, option.value))
                            }
                          >
                            <span>{option.value}</span>
                            <small>{option.description}</small>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ))}
                <section className="taxonomy-preset-group taxonomy-custom-option">
                  <h4>开放项</h4>
                  <button type="button" onClick={startCustomAnswer}>
                    <span>{openOption?.value ?? "其他（自主输入）"}</span>
                    <small>
                      {openOption?.description ??
                        "当现有词表不能准确覆盖时，自主填写新的判断。"}
                    </small>
                  </button>
                </section>
              </div>
            </div>
          </div>
        </div>
        <textarea
          ref={answerRef}
          rows={4}
          value={answer}
          aria-label={`${field.code} ${field.name} 我的判断`}
          placeholder="可选择预设项，也可直接自主输入"
          onChange={(event) => onAnswerChange(event.target.value)}
        />
      </div>
      <label className="taxonomy-evidence">
        <span>标注依据（可选）</span>
        <textarea
          rows={2}
          value={evidence}
          aria-label={`${field.code} ${field.name} 标注依据`}
          onChange={(event) => onEvidenceChange(event.target.value)}
        />
      </label>
    </article>
  );
}
