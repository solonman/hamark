// 客户需求复盘库的权限判定（docs/26 4.5）。纯函数，路由和服务层共用。
//
//   新建案例、传点评录音         任何已登录成员
//   改基本信息、回合、附件、关联、收尾、删除案例    案例上传者；系统管理员
//   移除一段点评录音            这段录音的上传者、案例上传者、系统管理员；老孙另可移除任何非 READY 的
//   生成、审阅、发布（月度整理）   老孙（isCaseReviewer），不另开别的例外
//
// 「老孙」能不能改别人的案例，取决于他是不是系统管理员，不单独放行。

import { isAppAdmin } from "@/lib/admin";
import { isCaseReviewer } from "@/lib/case-review";
import type { CurrentUser } from "@/lib/current-user";
import type { V04Actor } from "@/lib/v04-workspace-service";

export type RetroViewer = {
  userId: string;
  displayName: string;
  isReviewer: boolean;
  isAdmin: boolean;
};

/** 路由里每次现查管理员（同公共视觉：不复用陈旧判断）。 */
export async function loadRetroViewer(actor: Pick<V04Actor, "userId" | "displayName">): Promise<RetroViewer> {
  return {
    userId: actor.userId,
    displayName: actor.displayName,
    isReviewer: isCaseReviewer(actor.displayName),
    // isAppAdmin 只看显示名，这里不必有完整的 CurrentUser。
    isAdmin: await isAppAdmin({ displayName: actor.displayName } as CurrentUser),
  };
}

export function canEditRetroCase(retroCase: { createdByUserId: string }, viewer: Pick<RetroViewer, "userId" | "isAdmin">): boolean {
  return viewer.isAdmin || retroCase.createdByUserId === viewer.userId;
}

export function canRemoveRetroRecording(
  recording: { uploadedByUserId: string; status?: string },
  retroCase: { createdByUserId: string } | null,
  viewer: Pick<RetroViewer, "userId" | "isAdmin"> & { isReviewer?: boolean },
): boolean {
  if (viewer.isAdmin) return true;
  if (recording.uploadedByUserId === viewer.userId) return true;
  // 老孙可以清掉任何还没转写完成的点评录音（卡在上传中、失败的陈旧行也能清掉）；已就绪的不行。
  if (viewer.isReviewer && recording.status !== undefined && recording.status !== "READY") return true;
  return Boolean(retroCase && retroCase.createdByUserId === viewer.userId);
}
