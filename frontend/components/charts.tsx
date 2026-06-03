"use client";
// Recharts wrappers — dark terminal theme, thin strokes, accent fills.
// Static-export-safe (SVG only). Series are derived upstream in useMemo.
import {
  ResponsiveContainer, ComposedChart, BarChart, LineChart,
  Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  Cell, ReferenceLine, Area, AreaChart,
} from "recharts";

const AXIS = { fontSize: 11, fill: "var(--fg-2)", fontFamily: "var(--font-mono)" } as const;
const GRID = "var(--border-1)";
const ACCENT = "#4fd4c2";
const POS = "#3fb950";
const NEG = "#f05252";
const SERIES = [ACCENT, "#7aa2f7", "#f5a623", "#bb9af7", "#3fb950"];

const tooltipStyle = {
  background: "var(--bg-1)",
  border: "1px solid var(--border-1)",
  borderRadius: 6,
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  color: "var(--fg-0)",
};

function fmtTick(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(1)}T`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(0)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(0)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return String(v);
}

export type ChartRow = Record<string, string | number | null>;

export function ChartFrame({ title, children, height = 220 }: { title: string; children: React.ReactNode; height?: number }) {
  return (
    <div className="chart-card">
      <div className="chart-title">{title}</div>
      <div style={{ width: "100%", height }}>
        <ResponsiveContainer>{children as React.ReactElement}</ResponsiveContainer>
      </div>
    </div>
  );
}

/** Bars (absolute level) + a line overlay (growth rate on a right axis). */
export function ComboChart({
  data, barKey, lineKey, barName, lineName, title,
}: { data: ChartRow[]; barKey: string; lineKey: string; barName: string; lineName: string; title: string }) {
  return (
    <ChartFrame title={title}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="x" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis yAxisId="l" tick={AXIS} tickLine={false} axisLine={false} tickFormatter={fmtTick} width={44} />
        <YAxis yAxisId="r" orientation="right" tick={AXIS} tickLine={false} axisLine={false}
          tickFormatter={(v) => `${v}%`} width={40} />
        <Tooltip contentStyle={tooltipStyle} formatter={(v: number, n) => [n === lineName ? `${v?.toFixed?.(1)}%` : fmtTick(v), n]} />
        <Legend wrapperStyle={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--fg-2)" }} />
        <Bar yAxisId="l" dataKey={barKey} name={barName} fill={ACCENT} fillOpacity={0.7} radius={[2, 2, 0, 0]} />
        <Line yAxisId="r" dataKey={lineKey} name={lineName} stroke="#f5a623" strokeWidth={1.5} dot={false} connectNulls />
      </ComposedChart>
    </ChartFrame>
  );
}

/** Several bounded % series on a shared axis. */
export function MultiLineChart({
  data, lines, title,
}: { data: ChartRow[]; lines: { key: string; name: string }[]; title: string }) {
  return (
    <ChartFrame title={title}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="x" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} width={40} />
        <Tooltip contentStyle={tooltipStyle} formatter={(v: number, n) => [`${v?.toFixed?.(1)}%`, n]} />
        <Legend wrapperStyle={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--fg-2)" }} />
        {lines.map((l, i) => (
          <Line key={l.key} dataKey={l.key} name={l.name} stroke={SERIES[i % SERIES.length]}
            strokeWidth={1.5} dot={false} connectNulls />
        ))}
      </LineChart>
    </ChartFrame>
  );
}

/** Discrete per-period values. Optional sign-aware coloring. */
export function SimpleBarChart({
  data, barKey, title, signed,
}: { data: ChartRow[]; barKey: string; title: string; signed?: boolean }) {
  return (
    <ChartFrame title={title}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="x" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={fmtTick} width={44} />
        <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [fmtTick(v), barKey]} />
        <Bar dataKey={barKey} radius={[2, 2, 0, 0]}>
          {data.map((d, i) => (
            <Cell key={i} fill={signed && Number(d[barKey]) < 0 ? NEG : ACCENT} fillOpacity={0.8} />
          ))}
        </Bar>
      </BarChart>
    </ChartFrame>
  );
}

/** Two opposing balance-sheet series as paired bars. */
export function PairedBarChart({
  data, keyA, keyB, nameA, nameB, title,
}: { data: ChartRow[]; keyA: string; keyB: string; nameA: string; nameB: string; title: string }) {
  return (
    <ChartFrame title={title}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="x" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={fmtTick} width={44} />
        <Tooltip contentStyle={tooltipStyle} formatter={(v: number, n) => [fmtTick(v), n]} />
        <Legend wrapperStyle={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--fg-2)" }} />
        <Bar dataKey={keyA} name={nameA} fill={POS} fillOpacity={0.75} radius={[2, 2, 0, 0]} />
        <Bar dataKey={keyB} name={nameB} fill={NEG} fillOpacity={0.7} radius={[2, 2, 0, 0]} />
      </BarChart>
    </ChartFrame>
  );
}

/** Stacked bar — composition + volume over time (e.g. filings by form type). */
export function StackedBarChart({
  data, keys, title,
}: { data: ChartRow[]; keys: { key: string; name: string }[]; title: string }) {
  return (
    <ChartFrame title={title}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="x" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={32} />
        <Tooltip contentStyle={tooltipStyle} />
        <Legend wrapperStyle={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--fg-2)" }} />
        {keys.map((k, i) => (
          <Bar key={k.key} dataKey={k.key} name={k.name} stackId="s"
            fill={SERIES[i % SERIES.length]} fillOpacity={0.8} />
        ))}
      </BarChart>
    </ChartFrame>
  );
}

/** Ranked horizontal bar — value on x-axis, labels on y-axis. Good for top-N rankings. */
export function HorizontalBarChart({
  data, barKey, labelKey, title, unit = "",
}: { data: ChartRow[]; barKey: string; labelKey: string; title: string; unit?: string }) {
  const h = Math.max(180, data.length * 30);
  return (
    <ChartFrame title={title} height={h}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 4 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" horizontal={false} />
        <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} tickFormatter={fmtTick} />
        <YAxis
          type="category" dataKey={labelKey} width={116}
          tick={{ ...AXIS, textAnchor: "end", fontSize: 10 }}
          tickLine={false} axisLine={false}
          tickFormatter={(v: string) => v.length > 17 ? v.slice(0, 16) + "…" : v}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          formatter={(v: number) => [unit ? `${fmtTick(v)} ${unit}` : fmtTick(v), ""]}
        />
        <Bar dataKey={barKey} fill={ACCENT} fillOpacity={0.75} radius={[0, 3, 3, 0]} />
      </BarChart>
    </ChartFrame>
  );
}

/** Cumulative line — running sum of a series over time. Good for net insider flow. */
export function CumulativeLineChart({
  data, lineKey, title, signed,
}: { data: ChartRow[]; lineKey: string; title: string; signed?: boolean }) {
  return (
    <ChartFrame title={title}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={ACCENT} stopOpacity={0.2} />
            <stop offset="95%" stopColor={ACCENT} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="x" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={fmtTick} width={44} />
        <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [fmtTick(v), lineKey]} />
        {signed && <ReferenceLine y={0} stroke={GRID} strokeWidth={1} />}
        <Area dataKey={lineKey} stroke={ACCENT} strokeWidth={1.5} fill="url(#areaGrad)" dot={false} connectNulls />
      </AreaChart>
    </ChartFrame>
  );
}

/** Diverging bar — buys above zero axis (green), sells below (red). Net insider flow. */
export function DivergingBarChart({
  data, barKey, title,
}: { data: ChartRow[]; barKey: string; title: string }) {
  return (
    <ChartFrame title={title}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="x" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={fmtTick} width={44} />
        <Tooltip
          contentStyle={tooltipStyle}
          formatter={(v: number) => [
            fmtTick(Math.abs(v)),
            v >= 0 ? "Net Bought" : "Net Sold",
          ]}
        />
        <ReferenceLine y={0} stroke={GRID} strokeWidth={1} />
        <Bar dataKey={barKey} radius={[2, 2, 0, 0]}>
          {data.map((d, i) => (
            <Cell key={i} fill={Number(d[barKey]) >= 0 ? POS : NEG} fillOpacity={0.8} />
          ))}
        </Bar>
      </BarChart>
    </ChartFrame>
  );
}
