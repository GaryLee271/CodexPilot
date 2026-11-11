import type { ReactNode } from "react";
export function Switch({ on, disabled, label, onToggle }: { on: boolean; disabled?: boolean; label: string; onToggle: () => void }) {
  return (
    <button aria-checked={on} aria-label={label} className={`gw-switch ${on ? "is-on" : ""}`} disabled={disabled} onClick={onToggle} role="switch" type="button">
      <span />
    </button>
  );
}

export function SectionLabel({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="gw-section-label">
      <span>{children}</span>
      {aside ? <div className="gw-section-aside">{aside}</div> : null}
    </div>
  );
}
