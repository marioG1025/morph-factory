import { eventId, setStr } from "../vendor/llp/llp";

export function llp_schema(): i32 { return 1; }

export function llp_event(): void {
  if (eventId() == "release") setStr("__reply", "review");
  else setStr("__error", "Compare results requires an approved factory release.");
}
