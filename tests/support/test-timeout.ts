import { setDefaultTimeout } from "bun:test";

// The per-test timeout guards against hangs; it is not a speed requirement. Agent checks run on a
// slow, shared host where a delivery test that takes under a second locally can exceed Bun's
// 5-second default. A test that needs its own limit still passes it explicitly.
setDefaultTimeout(60_000);
