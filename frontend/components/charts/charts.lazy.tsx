"use client";
// Lazy chart wrappers. Recharts (~95 KB gzipped) is the largest single dependency,
// and charts only ever render inside data views — never on first paint of a fresh
// load. Wrapping each recharts wrapper in next/dynamic({ ssr: false }) splits the
// whole library into an on-demand chunk, keeping it out of the initial bundle; a
// brief SkeletonChart shows while the chunk streams in. Same names/props as
// ./charts, so call sites are unchanged — import from here instead of ./charts.
import dynamic from "next/dynamic";
import { SkeletonChart } from "../Skeletons";

const loading = () => <SkeletonChart />;

export const ComboChart = dynamic(() => import("./charts").then((m) => ({ default: m.ComboChart })), { ssr: false, loading });
export const MultiLineChart = dynamic(() => import("./charts").then((m) => ({ default: m.MultiLineChart })), { ssr: false, loading });
export const SimpleBarChart = dynamic(() => import("./charts").then((m) => ({ default: m.SimpleBarChart })), { ssr: false, loading });
export const PairedBarChart = dynamic(() => import("./charts").then((m) => ({ default: m.PairedBarChart })), { ssr: false, loading });
export const StackedBarChart = dynamic(() => import("./charts").then((m) => ({ default: m.StackedBarChart })), { ssr: false, loading });
export const DivergingBarChart = dynamic(() => import("./charts").then((m) => ({ default: m.DivergingBarChart })), { ssr: false, loading });
export const HorizontalBarChart = dynamic(() => import("./charts").then((m) => ({ default: m.HorizontalBarChart })), { ssr: false, loading });
export const CumulativeLineChart = dynamic(() => import("./charts").then((m) => ({ default: m.CumulativeLineChart })), { ssr: false, loading });
export const PriceChart = dynamic(() => import("./charts").then((m) => ({ default: m.PriceChart })), { ssr: false, loading });
