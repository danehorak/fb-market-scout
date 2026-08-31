import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profilePath = path.join(projectRoot, "data", "browser-profile");

async function main(): Promise<void> {
  console.log(`Using dedicated browser profile: ${profilePath}`);

  const context = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    viewport: null,
    args: ["--start-maximized"],
  });
  const browser = context.browser();
  if (!browser) {
    await context.close();
    throw new Error("Playwright did not return the persistent Chromium browser.");
  }
  const browserClosed = new Promise<void>((resolve) => {
    browser.once("disconnected", () => resolve());
  });

  const closeContext = (): void => {
    void context.close().catch(() => undefined);
  };

  process.once("SIGINT", closeContext);
  process.once("SIGTERM", closeContext);

  try {
    const page = context.pages()[0] ?? (await context.newPage());

    try {
      await page.goto("https://www.facebook.com/marketplace/", {
        waitUntil: "domcontentloaded",
      });
    } catch (error) {
      console.warn(
        "Marketplace did not finish loading automatically. Use the open browser to navigate there manually.",
      );
      console.warn(error instanceof Error ? error.message : String(error));
    }

    console.log(`
Facebook Marketplace is open.

1. Log into Facebook manually.
2. Complete any verification Facebook requests.
3. Confirm that Marketplace loads.
4. Close the browser window when finished.

Your authenticated session will remain in the ignored browser-profile directory.
`);

    await browserClosed;
  } finally {
    process.removeListener("SIGINT", closeContext);
    process.removeListener("SIGTERM", closeContext);
    await context.close().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error("Unable to launch the Facebook login browser.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
