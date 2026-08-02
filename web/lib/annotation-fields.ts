import taxonomyV02 from "./taxonomy-v0.2.json";

export type AnnotationFieldCode =
  | "A1"
  | "A2"
  | "A3"
  | "A4"
  | "A5"
  | "A6"
  | "A7"
  | "A8"
  | "A9"
  | "B1"
  | "B2"
  | "B3"
  | "B4"
  | "B5"
  | "B6"
  | "B7"
  | "B8"
  | "B9"
  | "B10";

export type AnnotationPresetOption = {
  category: string;
  value: string;
  description: string;
};

export type AnnotationFieldDefinition = {
  code: AnnotationFieldCode;
  name: string;
  question: string;
  rule: string;
  options: AnnotationPresetOption[];
};

// V0.2附表A、附表B是本文件的唯一词表来源；字段定义和预设值不得在界面中改写。
export const annotationFields = taxonomyV02 as AnnotationFieldDefinition[];
