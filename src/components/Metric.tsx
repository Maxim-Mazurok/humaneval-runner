import type { ReactNode } from "react";

export function Metric({
  label,
  value,
  children,
  tone
}: {
  label: string;
  value: ReactNode;
  children?: ReactNode;
  tone?: "passed" | "failed";
}) {
  return (
    <div className={`bench-metric${tone ? ` bench-metric-${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {children}
    </div>
  );
}

export function MetricLines({ lines }: { lines: Array<[string, string]> }) {
  return (
    <span className="metric-lines">
      {lines.map(([label, value]) => (
        <span className="metric-line" key={label}>
          <span>{label}</span>
          <b>{value}</b>
        </span>
      ))}
    </span>
  );
}
