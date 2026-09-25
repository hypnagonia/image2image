/**
 * Undo / redo: snapshots of the parameters (layers and the Develop settings),
 * one per committed change, labelled for the History list ("New Curves layer",
 * "Edit Hue/Saturation 1", "Layer order" …). Drags do not commit; their release
 * does, so a history step is one gesture, not one frame.
 */
import type { Params } from "../decision/params.ts";

export interface HistoryEntry { label: string; state: string }

export class History {
  private entries: HistoryEntry[] = [];
  private at = -1;
  private limit: number;
  constructor(limit = 100) { this.limit = limit; }

  /** Starts over with this state (a newly opened photo). */
  reset(p: Params, label: string) {
    this.entries = [{ label, state: JSON.stringify(p) }];
    this.at = 0;
  }
  /** Records a new state after the current one (dropping any redo branch). Same state → nothing. */
  commit(p: Params, label: string): boolean {
    const state = JSON.stringify(p);
    if (this.at >= 0 && this.entries[this.at].state === state) return false;
    this.entries = this.entries.slice(0, this.at + 1);
    this.entries.push({ label, state });
    if (this.entries.length > this.limit) this.entries.shift();
    this.at = this.entries.length - 1;
    return true;
  }
  get canUndo() { return this.at > 0; }
  get canRedo() { return this.at < this.entries.length - 1; }
  undo(): Params | undefined { if (!this.canUndo) return undefined; this.at--; return JSON.parse(this.entries[this.at].state); }
  redo(): Params | undefined { if (!this.canRedo) return undefined; this.at++; return JSON.parse(this.entries[this.at].state); }
  /** Jumps to a step of the list. */
  go(i: number): Params | undefined { if (i < 0 || i >= this.entries.length) return undefined; this.at = i; return JSON.parse(this.entries[i].state); }
  list(): Array<{ label: string; current: boolean }> { return this.entries.map((e, i) => ({ label: e.label, current: i === this.at })); }
}
