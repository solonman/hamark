export const V04_SCHEMA_APPLY_CONFIRMATION = "我确认仅安装 V0.4 DRAFT schema，不回填业务数据";
export const V04_SYSTEM_ADMIN_BOOTSTRAP_CONFIRMATION =
  "我确认仅恢复当前唯一稳定管理员的 SYSTEM_ADMIN 权限";
export const V04_CONTRACT_ACTIVATE_CONFIRMATION =
  "我确认仅激活三份 V0.4 冻结合同，不回填、不开放默认入口";
export const V04_CONTRACT_RETIRE_CONFIRMATION =
  "我确认仅停用三份 V0.4 合同并保留全部历史数据";

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

export type V04ContractLifecycleInput = {
  action: "ACTIVATE_CONTRACTS" | "RETIRE_CONTRACTS";
  confirmation: string;
  approvalReference: string;
  gateOneEvidenceReference: string;
  targetCodeSha: string;
  idempotencyKey: string;
};
