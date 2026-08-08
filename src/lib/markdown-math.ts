// remark-math options for chat rendering. singleDollarTextMath OFF means a lone
// `$` is treated as currency, not a math delimiter, so "$30. Each pays $10"
// renders as written instead of being swallowed into KaTeX and glued together
// (David 2026-08-08, seen in the thinking stream). Block math ($$…$$) still
// renders, which is what an actual formula uses in this app.
export const MATH_OPTIONS = { singleDollarTextMath: false } as const
