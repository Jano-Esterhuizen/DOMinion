import type { ReactNode } from "react";
import type { SetupItem, SetupResponse } from "../api";
import { SetupPill } from "../components";

/** The worst status among the checklist items a section fixes (to do > recommended > done). */
export function sectionStatus(setup: SetupResponse, section: SetupItem["section"], env?: string): string | undefined {
  const items = setup.items.filter((i) => i.section === section && (!env || i.env === env));
  if (!items.length) return undefined;
  if (items.some((i) => i.status === "todo")) return "todo";
  if (items.some((i) => i.status === "optional")) return "optional";
  return "done";
}

export function Step({ id, title, status, children }: { id: string; title: string; status?: string; children: ReactNode }) {
  return (
    <section className="card step" id={id} aria-labelledby={`${id}-title`}>
      <div className="row spread">
        <h2 id={`${id}-title`}>{title}</h2>
        {status ? <SetupPill status={status} /> : null}
      </div>
      {children}
    </section>
  );
}

/** A write-only secret: the value goes to .env.local and is never shown or sent back. */
export function SecretField({ label, name, set, fromShell, value, onChange }: { label: string; name: string; set: boolean; fromShell?: boolean; value: string; onChange: (value: string) => void }) {
  return (
    <label>
      <span>
        {label}{" "}
        <span className="muted">
          (<code>{name}</code>, {set ? (fromShell ? "set in your shell" : "saved") : "not set"})
        </span>
      </span>
      <input type="password" autoComplete="off" spellCheck={false} value={value} placeholder={set ? "saved; type to replace" : ""} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
