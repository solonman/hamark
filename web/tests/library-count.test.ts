import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { libraryCountLabel } from "../lib/library-count.ts";

const source = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("常态只报总数，搜索筛掉东西了才报「符合几个」", () => {
  assert.equal(libraryCountLabel(24, 24, "部"), "24 部");
  assert.equal(libraryCountLabel(7, 24, "部"), "符合 7 / 24 部");
  assert.equal(libraryCountLabel(2, 9, "份"), "符合 2 / 9 份");
  // 库里一个都没有时照常说 0，下面的空状态会解释为什么是空的。
  assert.equal(libraryCountLabel(0, 0, "部"), "0 部");
  assert.equal(libraryCountLabel(0, 9, "份"), "符合 0 / 9 份");
});

test("两个库的标题都挂着这个数量，单位各按各的", async () => {
  const video = await source("../components/v04/V04LibraryClient.tsx");
  const report = await source("../components/report/library/ReportLibrary.tsx");
  assert.match(video, /libraryCountLabel\(visible\.length, cases\.length, "部"\)/);
  assert.match(report, /libraryCountLabel\(visible\.length, reports\.length, "份"\)/);
  // 还没读出来和读失败的时候不摆数字——那会儿的 0 不是「库里没有」。
  assert.match(video, /VIDEO LIBRARY\{loading \|\| loadError \? null :/);
  assert.match(report, /REPORT LIBRARY\{loading \|\| loadError \? null :/);
});
