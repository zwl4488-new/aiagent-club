// 展示用格式化工具。

/**
 * 紧凑数字:141614 → "141.6k",618571109 → "618.6M"。
 * @param {number|undefined|null} n
 * @returns {string}
 */
export function compact(n) {
  if (n == null || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e12) return (n / 1e12).toFixed(1) + 'T'
  if (abs >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}

/**
 * 完整千分位:141614 → "141,614"(用于 title 悬浮显示精确值)。
 * @param {number|undefined|null} n
 * @returns {string}
 */
export function full(n) {
  if (n == null || !Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US')
}

const PRICE_FORMAT = new Intl.NumberFormat('en-US', {
  maximumSignificantDigits: 6,
  useGrouping: true,
})

/**
 * 每百万 token 美元价格。用有效数字消除 IEEE-754 浮点尾差，同时保留极小价格。
 * 负值是采集层的“无价格”哨兵，不应作为金额展示。
 * @param {number|undefined|null} n
 * @returns {string}
 */
export function price(n) {
  if (n == null || !Number.isFinite(n) || n < 0) return '—'
  return PRICE_FORMAT.format(n)
}
