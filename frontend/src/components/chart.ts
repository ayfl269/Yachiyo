import * as m from 'react-apexcharts'

type ChartComponent = typeof import('react-apexcharts').default

// react-apexcharts ships as CJS (`exports.default = Charts`, `__esModule: true`).
// Vite's interop differs between dev and prod:
//   - dev (esbuild pre-bundle): `export default <exports object>`, so the
//     component lands on `m.default.default`
//   - prod (Rollup @rollup/plugin-commonjs): may expose it on `m.default`
// Resolve both shapes, otherwise React throws error #130 ("element type is
// invalid: got object") when rendering `<Chart />`.
const mod = (m as unknown as { default: unknown }).default
const Chart: ChartComponent =
  typeof mod === 'function'
    ? (mod as ChartComponent)
    : ((mod as { default: ChartComponent }).default)
export default Chart
