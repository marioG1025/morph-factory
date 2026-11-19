import { view, event } from "./review";
export function llp_schema(): i32 { return 1; }
export function llp_view(): void { view(true); }
export function llp_event(): void { event(true); }
