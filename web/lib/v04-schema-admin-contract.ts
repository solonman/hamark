export const V04_SCHEMA_APPLY_CONFIRMATION = "我确认仅安装 V0.4 DRAFT schema，不回填业务数据";

export type V04SchemaApplyInput = {
  action: "APPLY_SCHEMA";
  previewToken: string;
  targetCodeSha: string;
  idempotencyKey: string;
  confirmation: string;
  approvalReference: string;
  backupReference: string;
  backupVerifiedAt: string;
};
