import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DominionError } from "../errors";
import type { RunHandle } from "./store";
import type { Proposal } from "./types";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function find(run: RunHandle, id: string): Proposal {
  const proposal = run.record.proposals?.find((p) => p.id === id);
  if (!proposal) throw new DominionError(`Run ${run.id} has no proposal "${id}".`, { code: "PROPOSAL_NOT_FOUND" });
  return proposal;
}

export function proposalDiff(run: RunHandle, id: string): string {
  return readFileSync(run.path(...find(run, id).diffFile.split("/")), "utf8");
}

/**
 * Applies a proposed change to a hand-written file, but only if the file is still exactly as it
 * was when the change was proposed (spec: Ownership, proposed diffs for approval).
 */
export function applyProposal(run: RunHandle, root: string, id: string): Proposal {
  const proposal = find(run, id);
  if (proposal.status !== "pending") throw new DominionError(`Proposal ${id} is already ${proposal.status}.`, { code: "PROPOSAL_NOT_PENDING" });
  const target = join(root, ...proposal.path.split("/"));
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (sha256(current) !== proposal.beforeHash) {
    throw new DominionError(`${proposal.path} changed since DOMinion proposed this edit, so it was not applied.`, {
      code: "PROPOSAL_STALE",
      hint: `Review the diff in ${run.path(...proposal.diffFile.split("/"))} and apply it by hand.`,
    });
  }
  writeFileSync(target, readFileSync(run.path(...proposal.afterFile.split("/")), "utf8"), "utf8");
  return setStatus(run, id, "applied");
}

export function rejectProposal(run: RunHandle, id: string): Proposal {
  return setStatus(run, id, "rejected");
}

function setStatus(run: RunHandle, id: string, status: Proposal["status"]): Proposal {
  let updated: Proposal | undefined;
  run.update((r) => {
    r.proposals = (r.proposals ?? []).map((p) => (p.id === id ? (updated = { ...p, status }) : p));
  });
  run.emit({ type: "log", level: "info", message: `Proposal ${id} (${updated!.path}) ${status}.` });
  return updated!;
}
