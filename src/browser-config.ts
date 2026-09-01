import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const profilePath = path.join(projectRoot, "data", "browser-profile");

function getCdpPort(): number {
  const value = process.env.FB_MARKET_SCOUT_CDP_PORT ?? "9222";
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("FB_MARKET_SCOUT_CDP_PORT must be an integer from 1024 through 65535.");
  }
  return port;
}

export const cdpPort = getCdpPort();
export const cdpEndpoint = `http://127.0.0.1:${cdpPort}`;
export const sharedBrowserArgs = [
  `--remote-debugging-port=${cdpPort}`,
  "--remote-debugging-address=127.0.0.1",
];
