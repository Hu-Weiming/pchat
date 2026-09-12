import type { HarnessEvent } from "@pchat/contracts";
import type { Clock, RuntimeState } from "./ports";

type EventInput = { [K in HarnessEvent["type"]]: Omit<Extract<HarnessEvent, { type: K }>, "seq" | "at"> }[HarnessEvent["type"]];
export function emit(state: RuntimeState, clock: Clock, event: EventInput): void {
  if (state.lastEventSeq >= Number.MAX_SAFE_INTEGER) throw new Error("Event sequence exhausted");
  state.events.push({ ...event, seq: ++state.lastEventSeq, at: clock.now() } as HarnessEvent);
}
