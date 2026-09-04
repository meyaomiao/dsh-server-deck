/**
 * 迷你趋势图:零依赖 SVG 折线,viewBox 等比拉伸铺满容器。
 * 纵轴固定 0-100%,离线 / 缺字段的点断开线段(不连成斜线)。
 * hover:竖线 + 数据点圆标 + 悬浮卡(时间 + 具体数值)。
 */

import { useState } from 'react';
import type { MetricPoint } from '../types.ts';

export type TrendField = 'cpu' | 'mem' | 'disk';

/** 阈值色级:与用量条一致(<60 绿 / 60-85 黄 / ≥85 红)。 */
export function valueClass(v: number | undefined): '' | 'warn' | 'bad' {
  if (v === undefined) return '';
  return v >= 85 ? 'bad' : v >= 60 ? 'warn' : '';
}

const COLORS: Record<string, string> = {
  '': '#3fb950',
  warn: '#d29922',
  bad: '#f85149',
};

const LOGICAL_W = 240;
const PAD = 2;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 悬浮卡时间:HH:MM(跨天窗口加 MM-DD)。 */
function fmtTipTime(t: number, from: number): string {
  const d = new Date(t);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (new Date(from).getDate() !== d.getDate()) {
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
  }
  return hm;
}

export function Sparkline(props: {
  points: readonly MetricPoint[];
  field: TrendField;
  from: number;
  to: number;
  /** 当前粒度毫秒数;相邻点间隔超过 2.5 倍即视为缺口断开。 */
  bucketMs: number;
  height?: number;
  /** 画 0/50/100 参考线(趋势视图用)。 */
  grid?: boolean;
}): React.ReactNode {
  const H = props.height ?? 40;
  const span = Math.max(1, props.to - props.from);
  const gapMs = props.bucketMs * 2.5;
  const [hover, setHover] = useState<{ xFrac: number; t: number; v: number | undefined } | null>(null);

  const x = (t: number): number => ((t - props.from) / span) * LOGICAL_W;
  const y = (v: number): number => H - PAD - (Math.min(100, Math.max(0, v)) / 100) * (H - PAD * 2);

  let d = '';
  let prevT: number | undefined;
  let latest: number | undefined;
  for (const p of props.points) {
    const v = p[props.field];
    if (!p.online || v === undefined) {
      prevT = undefined;
      continue;
    }
    latest = v;
    const cmd = prevT !== undefined && p.t - prevT <= gapMs ? 'L' : 'M';
    d += `${cmd}${x(p.t).toFixed(1)},${y(v).toFixed(1)} `;
    prevT = p.t;
  }

  const color = COLORS[valueClass(latest)];
  const gridY = [y(0), y(50), y(100)];

  // 悬浮定位:光标处时间 → 就近的有值数据点
  const onMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!(rect.width > 0)) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const t = props.from + frac * span;
    let best: MetricPoint | undefined;
    let bestD = Number.POSITIVE_INFINITY;
    for (const p of props.points) {
      if (!p.online || p[props.field] === undefined) continue;
      const dist = Math.abs(p.t - t);
      if (dist < bestD) {
        bestD = dist;
        best = p;
      }
    }
    setHover(best === undefined
      ? null
      : { xFrac: (best.t - props.from) / span, t: best.t, v: best[props.field] });
  };

  const hx = hover !== null ? hover.xFrac * LOGICAL_W : 0;
  const tipShift = hover === null
    ? undefined
    : hover.xFrac > 0.8 ? 'translateX(-100%)' : hover.xFrac < 0.15 ? 'translateX(0)' : 'translateX(-50%)';

  return (
    <div className="sd-spark-wrap">
      <svg
        className="sd-spark"
        viewBox={`0 0 ${LOGICAL_W} ${H}`}
        preserveAspectRatio="none"
        style={{ height: H }}
        role="img"
        aria-label={`${props.field} trend`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {props.grid === true ? (
          <g>
            {gridY.map((gy) => (
              <line key={gy} x1={0} x2={LOGICAL_W} y1={gy} y2={gy}
                stroke="rgba(128,128,128,.16)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            ))}
          </g>
        ) : null}
        {d.length > 0 ? (
          <path d={d} fill="none" stroke={color} strokeWidth={1.5}
            vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        ) : null}
        {hover !== null ? (
          <g>
            <line x1={hx} x2={hx} y1={0} y2={H}
              stroke="rgba(230,237,243,.4)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            {hover.v !== undefined ? (
              <circle cx={hx} cy={y(hover.v)} r={2.6}
                fill={COLORS[valueClass(hover.v)]} stroke="rgba(13,17,23,.9)" strokeWidth={1} />
            ) : null}
          </g>
        ) : null}
      </svg>
      {hover !== null ? (
        <div className="sd-spark-tip" style={{ left: `${hover.xFrac * 100}%`, transform: tipShift }}>
          <b>{fmtTipTime(hover.t, props.from)}</b>
          <span>{hover.v === undefined ? '—' : `${String(Math.round(hover.v * 10) / 10)}%`}</span>
        </div>
      ) : null}
    </div>
  );
}
