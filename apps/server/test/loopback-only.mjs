// Preload for isolated server subprocesses: refuse all external provider fetches.
const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error(`Isolated test blocked an external fetch to ${url.origin}`);
  return original(input, init);
};
