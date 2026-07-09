import type { ReactNode } from "react";

export type MetricLine = [string, string] | "separator";

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

export function MetricLines({ lines }: { lines: MetricLine[] }) {
  return (
    <span className="metric-lines">
      {lines.map((line, lineIndex) => {
        if (line === "separator") {
          return <span className="metric-line-separator" key={`separator-${lineIndex}`} />;
        }
        const [label, value] = line;
        return (
          <span className="metric-line" key={label}>
            <span>{label}</span>
            <b>{value}</b>
          </span>
        );
      })}
    </span>
  );
}
