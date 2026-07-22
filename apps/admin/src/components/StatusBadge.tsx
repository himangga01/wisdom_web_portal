export function StatusBadge({ value }: { value: string }) {
  const tone = value === "active" || value === "approved" || value === "published" || value === "ready"
    ? "success"
    : value === "failed" || value === "rejected" || value === "not ready"
      ? "danger"
      : "neutral";
  return <span className={`badge badge-${tone}`}>{value}</span>;
}
