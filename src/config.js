import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // .../src

// Storage defaults relative to the SERVER SCRIPT, never process.cwd() —
// Claude Desktop launches MCP servers from "/" or the home dir.
const defaultStorage = path.join(HERE, "..", "storage");

export const CONFIG = {
  replicateToken: process.env.REPLICATE_API_TOKEN,
  klingModel: process.env.KLING_MODEL ?? "kwaivgi/kling-v2.5-turbo-pro",
  storageDir: process.env.STORAGE_DIR ?? defaultStorage,
};

export const CLIPS_DIR = path.join(CONFIG.storageDir, "clips");
export const OUTPUT_DIR = path.join(CONFIG.storageDir, "output");
