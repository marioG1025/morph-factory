import { eventId, setStr } from "../vendor/llp/llp";

export function llp_schema(): i32 { return 1; }

export function llp_event(): void {
  const op = eventId();
  if (op == "release") setStr("__reply", "compare");
  else if (op == "compare") setStr("__reply", "allowed");
  else setStr("__error", "Unknown review service operation.");
}
