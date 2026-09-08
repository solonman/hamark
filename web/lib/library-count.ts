/**
 * 库标题旁边那一行英文眉标后面挂的案例数量。
 *
 * 常态只报一个总数；搜索把东西筛掉了才把「符合几个」摆到前面——搜完只看见总数，
 * 用户是看不出自己筛掉了多少的。搜索词碰巧一个都没筛掉时仍按常态说，
 * 「符合 24 / 24」是句废话。
 */
export function libraryCountLabel(matched: number, total: number, unit: string): string {
  return matched >= total ? `${total} ${unit}` : `符合 ${matched} / ${total} ${unit}`;
}
