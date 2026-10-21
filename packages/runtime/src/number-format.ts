/**
 * `zena:host:number`: the number conversions a `--target js` module imports
 * (stdlib `core/number-format-js.zena` and `core/number-parse-js.zena`).
 *
 * They are JavaScript's own. The stdlib makes up the differences between
 * them and Zena's `String` and `parseF64` on its side, so a program gives
 * the same results on every target without code here.
 */
export const numberImports = {
  String,
  toPrecision: (value: number, digits: number) => value.toPrecision(digits),
  parseFloat,
};
