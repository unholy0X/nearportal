// Monotonic in-process data version, bumped on every task or bounty write. Read models cache
// against it, so cached aggregates are invalidated by any relevant change (single instance only).
let version = 0;
export const bumpDataVersion = () => ++version;
export const dataVersion = () => version;
