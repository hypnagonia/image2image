/**
 * Built-in look profiles: only Neutral — the technically corrected rendering
 * with no creative grade. Every other look is the user's own: made from a
 * reference photo, matched to one, imported (.cube / JSON) or edited by hand
 * (Look tab); they are kept on this device.
 */
import { makeProfile, type LookProfile } from "./profile.ts";

export const BUILTIN_PROFILES: LookProfile[] = [
  makeProfile({ id: "neutral", name: "Neutral", category: "neutral", description: "No creative grade — the technically corrected rendering." }),
];

export const DEFAULT_PROFILE_ID = "neutral";
