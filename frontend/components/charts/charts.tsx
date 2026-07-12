"use client";
// Recharts wrappers — dark terminal theme, thin strokes, accent fills.
// Static-export-safe (SVG only). Series are derived upstream in useMemo.
import { useState } from "react";
import {
  ResponsiveContainer, ComposedChart, BarChart, LineChart,
  Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  Cell, ReferenceLine, ReferenceDot, Area, AreaChart,
} from "recharts";
import { InfoTip } from "../InfoTip";

const AXIS = { fontSize: 11, fill: "var(--fg-2)", fontFamily: "var(--font-mono)" } as const;
const GRID = "var(--border-1)";
const ACCENT = "#3b82f6";
const POS = "#22c55e";
const NEG = "#ef4444";
// Categorical series — fixed order, validated (six-checks) on the #111726 panel:
// blue → amber → teal → violet → pink; status POS/NEG never reused as series.
const SERIES = [ACCENT, "#d97706", "#0d9488", "#8b5cf6", "#db2777"];

// Faint accent wash drawn behind the hovered category/point.
const CURSOR_FILL = { fill: "rgba(59,130,246,0.08)" };
const CURSOR_LINE = { stroke: "rgba(59,130,246,0.35)", strokeWidth: 1 };

function fmtTick(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(1)}T`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(0)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(0)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return String(v);
}

const fmtMoney = (v: number | null) => (v == null ? "—" : `$${fmtTick(v)}`);
const fmtPctVal = (v: number | null) => (v == null ? "—" : `${v.toFixed(1)}%`);
// Combo/series charts mix levels and rates: a %-named series prints as a percent.
function fmtSmart(v: number | null, name?: string): string {
  if (v == null) return "—";
  return name && /%|margin|yoy|qoq|growth/i.test(name) ? `${v.toFixed(1)}%` : `$${fmtTick(v)}`;
}

export type ChartRow = Record<string, string | number | null>;

type TipPayload = { name?: string; value?: number | null; color?: string; dataKey?: string | number };

/** Shared interactive tooltip: a period header over color-keyed, formatted rows. */
function ChartTip({
  active, payload, label, fmt,
}: {
  active?: boolean; payload?: TipPayload[]; label?: string | number;
  fmt: (v: number | null, name?: string) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rt-tip">
      {label != null && <div className="rt-tip-head">{label}</div>}
      {payload.map((p, i) => (
        <div className="rt-tip-row" key={i}>
          <span className="rt-tip-dot" style={{ background: p.color }} />
          <span className="rt-tip-name">{p.name}</span>
          <span className="rt-tip-val">{fmt(p.value ?? null, p.name)}</span>
        </div>
      ))}
    </div>
  );
}

const legendStyle = { fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--fg-2)", cursor: "pointer" } as const;

/** Track which series the user has toggled off by clicking the legend. */
function useHidden() {
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const toggle = (key?: unknown) => {
    if (typeof key !== "string" && typeof key !== "number") return;
    setHidden((h) => ({ ...h, [String(key)]: !h[String(key)] }));
  };
  const isHidden = (key: string) => !!hidden[key];
  return { toggle, isHidden };
}

export function ChartFrame({
  title, children, height = 220, info,
}: { title: string; children: React.ReactNode; height?: number; info?: string }) {
  return (
    <div className="chart-card">
      <div className="chart-title">
        <span>{title}</span>
        {info && <InfoTip def={info} />}
      </div>
      <div style={{ width: "100%", height }}>
        <ResponsiveContainer>{children as React.ReactElement}</ResponsiveContainer>
      </div>
    </div>
  );
}

/** Bars (absolute level) + a line overlay (growth rate on a right axis). */
export function ComboChart({
  data, barKey, lineKey, barName, lineName, title, info,
}: { data: ChartRow[]; barKey: string; lineKey: string; barName: string; lineName: string; title: string; info?: string }) {
  const { toggle, isHidden } = useHidden();
  return (
    <ChartFrame title={title} info={info}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="x" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis yAxisId="l" tick={AXIS} tickLine={false} axisLine={false} tickFormatter={fmtTick} width={44} />
        <YAxis yAxisId="r" orientation="right" tick={AXIS} tickLine={false} axisLine={false}
          tickFormatter={(v) => `${v}%`} width={40} />
        <Tooltip cursor={CURSOR_FILL} content={<ChartTip fmt={fmtSmart} />} />
        <Legend wrapperStyle={legendStyle} onClick={(o) => toggle(o.dataKey)} />
        <Bar yAxisId="l" dataKey={barKey} name={barName} hide={isHidden(barKey)} fill={ACCENT} fillOpacity={0.7} radius={[2, 2, 0, 0]} />
        <Line yAxisId="r" dataKey={lineKey} name={lineName} hide={isHidden(lineKey)} stroke="#d97706" strokeWidth={1.5} dot={false} activeDot={{ r: 4 }} connectNulls />
      </ComposedChart>
    </ChartFrame>
  );
}

/** Several bounded % series on a shared axis. Click a legend item to isolate it. */
export function MultiLineChart({
  data, lines, title, info,
}: { data: ChartRow[]; lines: { key: string; name: string }[]; title: string; info?: string }) {
  const { toggle, isHidden } = useHidden();
  return (
    <ChartFrame title={title} info={info}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="x" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} width={40} />
        <Tooltip cursor={CURSOR_LINE} content={<ChartTip fmt={fmtPctVal} />} />
        <Legend wrapperStyle={legendStyle} onClick={(o) => toggle(o.dataKey)} />
        {lines.map((l, i) => (
          <Line key={l.key} dataKey={l.key} name={l.name} hide={isHidden(l.key)} stroke={SERIES[i % SERIES.length]}
            strokeWidth={1.5} dot={false} activeDot={{ r: 4 }} connectNulls />
        ))}
      </LineChart>
    </ChartFrame>
  );
}

/** Discrete per-period values. Optional sign-aware coloring. */
export function SimpleBarChart({
  data, barKey, title, signed, info,
}: { data: ChartRow[]; barKey: string; title: string; signed?: boolean; info?: string }) {
  return (
    <ChartFrame title={title} info={info}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="x" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={fmtTick} width={44} />
        <Tooltip cursor={CURSOR_FILL} content={<ChartTip fmt={(v) => String(fmtTick(v ?? 0))} />} />
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
  data, keyA, keyB, nameA, nameB, title, info,
}: { data: ChartRow[]; keyA: string; keyB: string; nameA: string; nameB: string; title: string; info?: string }) {
  const { toggle, isHidden } = useHidden();
  return (
    <ChartFrame title={title} info={info}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="x" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={fmtTick} width={44} />
        <Tooltip cursor={CURSOR_FILL} content={<ChartTip fmt={fmtMoney} />} />
        <Legend wrapperStyle={legendStyle} onClick={(o) => toggle(o.dataKey)} />
        <Bar dataKey={keyA} name={nameA} hide={isHidden(keyA)} fill={POS} fillOpacity={0.75} radius={[2, 2, 0, 0]} />
        <Bar dataKey={keyB} name={nameB} hide={isHidden(keyB)} fill={NEG} fillOpacity={0.7} radius={[2, 2, 0, 0]} />
      </BarChart>
    </ChartFrame>
  );
}

/** Stacked bar — composition + volume over time (e.g. filings by form type). */
export function StackedBarChart({
  data, keys, title, info,
}: { data: ChartRow[]; keys: { key: string; name: string }[]; title: string; info?: string }) {
  const { toggle, isHidden } = useHidden();
  return (
    <ChartFrame title={title} info={info}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="x" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={32} />
        <Tooltip cursor={CURSOR_FILL} content={<ChartTip fmt={(v) => String(v ?? 0)} />} />
        <Legend wrapperStyle={legendStyle} onClick={(o) => toggle(o.dataKey)} />
        {keys.map((k, i) => (
          <Bar key={k.key} dataKey={k.key} name={k.name} stackId="s" hide={isHidden(k.key)}
            fill={SERIES[i % SERIES.length]} fillOpacity={0.8} />
        ))}
      </BarChart>
    </ChartFrame>
  );
}

/** Ranked horizontal bar — value on x-axis, labels on y-axis. Good for top-N rankings. */
export function HorizontalBarChart({
  data, barKey, labelKey, title, unit = "", info,
}: { data: ChartRow[]; barKey: string; labelKey: string; title: string; unit?: string; info?: string }) {
  const h = Math.max(180, data.length * 30);
  return (
    <ChartFrame title={title} height={h} info={info}>
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
          cursor={CURSOR_FILL}
          content={<ChartTip fmt={(v) => (unit ? `${fmtTick(v ?? 0)} ${unit}` : `$${fmtTick(v ?? 0)}`)} />}
        />
        <Bar dataKey={barKey} fill={ACCENT} fillOpacity={0.75} radius={[0, 3, 3, 0]} />
      </BarChart>
    </ChartFrame>
  );
}

/** Cumulative line — running sum of a series over time. Good for net insider flow. */
export function CumulativeLineChart({
  data, lineKey, title, signed, info,
}: { data: ChartRow[]; lineKey: string; title: string; signed?: boolean; info?: string }) {
  return (
    <ChartFrame title={title} info={info}>
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
        <Tooltip cursor={CURSOR_LINE} content={<ChartTip fmt={(v) => String(fmtTick(v ?? 0))} />} />
        {signed && <ReferenceLine y={0} stroke={GRID} strokeWidth={1} />}
        <Area dataKey={lineKey} stroke={ACCENT} strokeWidth={1.5} fill="url(#areaGrad)" dot={false} activeDot={{ r: 4 }} connectNulls />
      </AreaChart>
    </ChartFrame>
  );
}

/** Price line ($ axis) with optional 50/200-day SMA overlays and event markers. */
export function PriceChart({
  data, markers, title, info, height = 240,
}: {
  data: ChartRow[];
  markers?: { x: string; y: number; color: string }[];
  title: string; info?: string; height?: number;
}) {
  const { toggle, isHidden } = useHidden();
  return (
    <ChartFrame title={title} info={info} height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="x" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={48} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={(v) => `$${fmtTick(v)}`} width={52} domain={["auto", "auto"]} />
        <Tooltip cursor={CURSOR_LINE} content={<ChartTip fmt={fmtMoney} />} />
        <Legend wrapperStyle={legendStyle} onClick={(o) => toggle(o.dataKey)} />
        <Line dataKey="Close" name="Close" hide={isHidden("Close")} stroke={ACCENT} strokeWidth={1.5} dot={false} connectNulls />
        <Line dataKey="SMA50" name="50d" hide={isHidden("SMA50")} stroke="#0d9488" strokeWidth={1} dot={false} connectNulls />
        <Line dataKey="SMA200" name="200d" hide={isHidden("SMA200")} stroke="#d97706" strokeWidth={1} dot={false} connectNulls />
        {(markers ?? []).map((m, i) => (
          <ReferenceDot key={i} x={m.x} y={m.y} r={3.5} fill={m.color} stroke="var(--bg-0)" strokeWidth={1} ifOverflow="extendDomain" />
        ))}
      </LineChart>
    </ChartFrame>
  );
}

/** Diverging bar — buys above zero axis (green), sells below (red). Net insider flow. */
/** Two signed contract-count series around a zero line (COT: specs vs commercials). */
export function NetPositionChart({
  data, lines, title, info, height,
}: { data: ChartRow[]; lines: { key: string; name: string }[]; title: string; info?: string; height?: number }) {
  const { toggle, isHidden } = useHidden();
  const fmtContracts = (v: number | null) =>
    v == null ? "—" : `${v >= 0 ? "+" : "−"}${fmtTick(Math.abs(v))}`;
  return (
    <ChartFrame title={title} info={info} height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="x" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={32} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={fmtTick} width={52} />
        <Tooltip cursor={CURSOR_LINE} content={<ChartTip fmt={fmtContracts} />} />
        <Legend wrapperStyle={legendStyle} onClick={(o) => toggle(o.dataKey)} />
        <ReferenceLine y={0} stroke={GRID} strokeWidth={1} />
        {lines.map((l, i) => (
          <Line key={l.key} dataKey={l.key} name={l.name} hide={isHidden(l.key)} stroke={SERIES[i % SERIES.length]}
            strokeWidth={1.5} dot={false} activeDot={{ r: 4 }} connectNulls />
        ))}
      </LineChart>
    </ChartFrame>
  );
}

export function DivergingBarChart({
  data, barKey, title, info,
}: { data: ChartRow[]; barKey: string; title: string; info?: string }) {
  return (
    <ChartFrame title={title} info={info}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="x" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={fmtTick} width={44} />
        <Tooltip
          cursor={CURSOR_FILL}
          content={<ChartTip fmt={(v) => `${(v ?? 0) >= 0 ? "Bought " : "Sold "}$${fmtTick(Math.abs(v ?? 0))}`} />}
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
