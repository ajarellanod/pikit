/**
 * A switch on the shared `.switch` classes (index.css): ink when on, the field grey when off, its thumb
 * the page's colour, so it reads in both themes. `md`: a 16px thumb (20px on touch); `sm` a smaller one
 * (menu rows).
 */
export function Switch({ checked, onChange, label, size = "md" }: { checked: boolean; onChange?: (value: boolean) => void; label?: string; size?: "sm" | "md" }) {
  return (
    <span
      role="switch"
      aria-checked={checked}
      aria-label={label}
      tabIndex={onChange === undefined ? -1 : 0}
      onClick={onChange === undefined ? undefined : () => onChange(!checked)}
      onKeyDown={(event) => {
        if (onChange !== undefined && (event.key === " " || event.key === "Enter")) {
          event.preventDefault();
          onChange(!checked);
        }
      }}
      className={`switch ${size === "sm" ? "switch-sm" : ""}`}
    >
      <span className="switch-thumb" />
    </span>
  );
}
