import type { Lifecycle } from "../lifecycle.js";
import { MUTATING } from "../tools.js";
import { logError } from "../output.js";

/**
 * Ask before a tool changes anything on disk.
 *
 * This is the case PreToolUse was built for: a hook that decides, rather than
 * one that watches. It runs mid-turn, while the model is waiting, so the
 * spinner is stopped for the question and the answer goes back as the tool's
 * result — a refusal is information the model can act on, not a crash.
 *
 * Reads are never asked about. Approving each one would train the habit of
 * saying yes, which is the failure mode this is meant to prevent.
 */

export type Ask = (question: string) => Promise<string>;

export type ApprovalMode = "ask" | "allow" | "deny";

export function approvalMode(): ApprovalMode {
  const v = (process.env.GAHOOLE_APPROVE ?? "ask").toLowerCase();
  return v === "allow" || v === "deny" ? v : "ask";
}

/** A one-line description of what the call would do, for the prompt. */
function describe(tool: string, input: unknown): string {
  const i = (input ?? {}) as {
    path?: string;
    name?: string;
    content?: string;
    old?: string;
    new?: string;
  };
  switch (tool) {
    case "write_file":
      return `write ${i.path} (${(i.content ?? "").length} chars)`;
    case "edit_file":
      return `edit ${i.path}: ${preview(i.old)} → ${preview(i.new)}`;
    case "write_note":
      return `save note ${i.name}`;
    default:
      return `${tool} ${JSON.stringify(input).slice(0, 80)}`;
  }
}

const preview = (s?: string): string => {
  const one = (s ?? "").replace(/\s+/g, " ").trim();
  return one.length > 40 ? `"${one.slice(0, 40)}…"` : `"${one}"`;
};

export function registerApproval(
  lifecycle: Lifecycle,
  ask: Ask,
  opts: { mode?: ApprovalMode; pause?: () => void; resume?: () => void } = {},
): void {
  const mode = opts.mode ?? approvalMode();
  if (mode === "allow") return;

  // Remembered for the session, so "always" is not asked again.
  const always = new Set<string>();

  lifecycle.on("PreToolUse", async (e) => {
    if (!MUTATING.has(e.toolName)) return;
    if (always.has(e.toolName)) return;

    if (mode === "deny") {
      return { deny: `${e.toolName} is disabled (GAHOOLE_APPROVE=deny)` };
    }

    opts.pause?.();
    try {
      const answer = (
        await ask(`\n  \x1b[33m${describe(e.toolName, e.input)}\x1b[0m\n  allow? [y/N/a] `)
      )
        .trim()
        .toLowerCase();

      if (answer === "a" || answer === "always") {
        always.add(e.toolName);
        return;
      }
      if (answer === "y" || answer === "yes") return;
      return { deny: "the user declined this change" };
    } catch {
      // No one to ask — refusing is the safe direction.
      logError("  no terminal to confirm on; declining");
      return { deny: "no interactive terminal to confirm the change" };
    } finally {
      opts.resume?.();
    }
  });
}
