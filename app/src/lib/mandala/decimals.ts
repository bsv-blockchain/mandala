/** `dec` is an integer 0..18 (0162:246-252); anything else displays as 0. */
export function decimalsOf (v: unknown): number {
  const d = Number(v)
  return Number.isInteger(d) && d >= 0 && d <= 18 ? d : 0
}
