export const V04_SCHEMA_APPLY_CONFIRMATION = "我确认仅安装 V0.4 DRAFT schema，不回填业务数据";
export const V04_SYSTEM_ADMIN_BOOTSTRAP_CONFIRMATION =
  "我确认仅恢复当前唯一稳定管理员的 SYSTEM_ADMIN 权限";

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

export type V04SystemAdminBootstrapInput = {
  action: "BOOTSTRAP_SYSTEM_ADMIN";
  confirmation: string;
  approvalReference: string;
  targetCodeSha: string;
  idempotencyKey: string;
};
