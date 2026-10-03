import * as Effect from "effect/Effect";

// Fork automations gave way to V2 scheduled tasks. Applied databases record this id, so it stays
// registered; the tables it created there are left alone.
export default Effect.void;
