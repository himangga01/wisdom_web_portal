import type { FC } from "hono/jsx";

// Server-generated SVG chart for the no-client-JS admin. All geometry is
// computed here; the only interactivity is the browser-native hover tooltip
// that <title> children provide. hono/jsx emits kebab-case SVG attributes
// verbatim, so no attribute mapping layer is needed.

export interface ChartPoint {
  label: string;
  value: number;
  /** Native tooltip text (e.g. "2026-07-24 · 조회 132회"). */
  tooltip: string;
}

const WIDTH = 640;
const HEIGHT = 220;
const PAD_LEFT = 46;
const PAD_RIGHT = 10;
const PAD_TOP = 10;
const PAD_BOTTOM = 26;
const PLOT_WIDTH = WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_HEIGHT = HEIGHT - PAD_TOP - PAD_BOTTOM;
const MAX_X_LABELS = 10;

// Classic 1-2-5 "nice" axis: returns the tick step for a target of ~4 ticks.
function niceStep(maxValue: number): number {
  const raw = Math.max(1, maxValue) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  for (const factor of [1, 2, 5, 10]) {
    if (raw <= factor * magnitude) return factor * magnitude;
  }
  return 10 * magnitude;
}

export const LineChart: FC<{ points: readonly ChartPoint[]; ariaLabel: string }> = ({ points, ariaLabel }) => {
  const maxValue = Math.max(1, ...points.map((point) => point.value));
  const step = niceStep(maxValue);
  const top = Math.ceil(maxValue / step) * step;
  const ticks: number[] = [];
  for (let tick = 0; tick <= top; tick += step) ticks.push(tick);

  const x = (index: number): number => points.length <= 1
    ? PAD_LEFT + PLOT_WIDTH / 2
    : PAD_LEFT + (index * PLOT_WIDTH) / (points.length - 1);
  const y = (value: number): number => PAD_TOP + PLOT_HEIGHT - (value / top) * PLOT_HEIGHT;
  const line = points.map((point, index) => `${x(index).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ");
  const labelStep = Math.max(1, Math.ceil(points.length / MAX_X_LABELS));

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={ariaLabel}
      class="analytics-chart"
      preserveAspectRatio="xMidYMid meet"
    >
      {ticks.map((tick) => (
        <g>
          <line
            x1={PAD_LEFT} y1={y(tick).toFixed(1)} x2={WIDTH - PAD_RIGHT} y2={y(tick).toFixed(1)}
            stroke="#d6d3d1" stroke-width="1"
          />
          <text x={PAD_LEFT - 6} y={(y(tick) + 4).toFixed(1)} text-anchor="end" font-size="11" fill="#6b7280">
            {tick}
          </text>
        </g>
      ))}
      {points.map((point, index) => (
        index % labelStep === 0 ? (
          <text x={x(index).toFixed(1)} y={HEIGHT - 8} text-anchor="middle" font-size="11" fill="#6b7280">
            {point.label}
          </text>
        ) : null
      ))}
      {points.length > 1 ? (
        <polyline points={line} fill="none" stroke="#1d4ed8" stroke-width="2" />
      ) : null}
      {points.map((point, index) => (
        <circle cx={x(index).toFixed(1)} cy={y(point.value).toFixed(1)} r="3.5" fill="#1d4ed8">
          <title>{point.tooltip}</title>
        </circle>
      ))}
    </svg>
  );
};
