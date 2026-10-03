import * as Effect from "effect/Effect";

// Fork automations gave way to V2 scheduled tasks. Applied databases record this id, so it stays
// registered; the column it added there is left alone.
export default Effect.void;
