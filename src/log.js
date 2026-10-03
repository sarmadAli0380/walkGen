// The ONLY logging path. stdout is the JSON-RPC protocol stream on stdio
// transport — a single console.log anywhere in src/ corrupts it. Everything
// diagnostic goes to stderr through here.
export const log = (...args) =>
  process.stderr.write(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n");
