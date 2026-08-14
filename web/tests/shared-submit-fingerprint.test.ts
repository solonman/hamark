import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { emptyAnnotation } from "../lib/annotation-server.ts";
import { sharedContentFingerprint } from "../lib/v03-collaboration.ts";

function draft() {
  const value = emptyAnnotation("test_only_video", "TEST_ONLY 作者", "V0.3-PILOT");
  value.id = "test_only_annotation";
  value.revision = 39;
  value.analysisTitle = "TEST_ONLY 标题";
  value.shotGroups = [{
    id: "test_only_group_1", orderIndex: 0, title: "桥段一",
    primaryRole: "建立场景／处境", auxiliaryRoles: [], customRole: "", note: "说明",
  }];
  value.shots = [{
    id: "test_only_shot_1", orderIndex: 0, shotGroupId: "test_only_group_1",
    groupName: "桥段一", shotNumber: "1", startTime: "", endTime: "00:01",
    shotSize: "大特写", cameraAngle: "正面平视", cameraMovement: "固定镜头",
    visualContent: "画面", dialogue: "", voiceover: "", screenText: "",
    soundEffect: "", music: "", creativeComment: "",
  }];
  return value;
}

// 工作快照的 payload 由客户端对象拼装，键序随客户端；重新读库得到的是库内键序。
// 提交前的一致性判定必须无视这个差异，否则同一份内容会被判成冲突，
// 而提示里的"刷新后重试"根本改变不了已经冻结在快照里的键序。
test("键序不同不改变内容指纹", () => {
  const fromDb = draft();
  const fromClient = draft();
  // 客户端侧的 shot 少了 shotGroupId 这一位置上的顺序，靠后才补上
  const { shotGroupId, ...rest } = fromClient.shots[0];
  fromClient.shots[0] = { ...rest, shotGroupId } as typeof fromClient.shots[0];

  assert.notEqual(
    JSON.stringify(fromDb),
    JSON.stringify(fromClient),
    "前提：两者序列化后的字节确实不同",
  );
  assert.equal(
    sharedContentFingerprint(fromDb),
    sharedContentFingerprint(fromClient),
  );
});

// 提交动作本身会把 status / reviewStatus / activeBaseSnapshotId 改写掉，
// 把它们算进指纹会让已提交过的作业再也提交不了。
test("流转字段变化不改变内容指纹", () => {
  const before = draft();
  const after = draft();
  after.status = "SUBMITTED";
  after.reviewStatus = "PENDING_REVIEW";
  after.activeBaseSnapshotId = "working_snapshot_test_only";
  after.updatedAt = "2026-08-14T04:17:50.333Z";

  assert.equal(
    sharedContentFingerprint(before),
    sharedContentFingerprint(after),
  );
});

test("真实内容差异仍然被指纹识别", () => {
  const before = draft();
  const afterText = draft();
  afterText.shots[0].visualContent = "改过的画面";
  assert.notEqual(
    sharedContentFingerprint(before),
    sharedContentFingerprint(afterText),
  );

  const afterGroup = draft();
  afterGroup.shotGroups = [];
  assert.notEqual(
    sharedContentFingerprint(before),
    sharedContentFingerprint(afterGroup),
  );

  const afterRevision = draft();
  afterRevision.revision = 40;
  assert.notEqual(
    sharedContentFingerprint(before),
    sharedContentFingerprint(afterRevision),
  );
});

// 提交路径不能再退回到"字节哈希比对 + 提示刷新"的老形态。
test("提交路径不再用字节哈希拦截提交", async () => {
  const source = await readFile(
    new URL("../app/api/videos/[id]/annotation/submit/route.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    !source.includes("当前修订号对应的快照内容不一致"),
    "刷新解决不了的死路提示必须已经移除",
  );
  assert.ok(
    source.includes("pg_advisory_xact_lock"),
    "提交必须和保存路径共用逻辑工作区锁来串行化并发",
  );
  assert.ok(
    source.includes("sharedContentFingerprint"),
    "内容是否落后应当由指纹判定并留痕",
  );
});
