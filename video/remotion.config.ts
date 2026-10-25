import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);

/** CRF 16 is visually lossless for the flat vector fields this video is made of. */
Config.setCrf(16);

/**
 * Remotion's own Chrome Headless Shell could not be downloaded in this
 * environment, so renders use the Chrome already on the machine. Forward
 * slashes on purpose: Node accepts them on Windows and they survive every
 * layer of quoting between here and the spawn.
 *
 * Override with PACT_CHROME if yours lives elsewhere, or delete this call
 * entirely once `npx remotion browser ensure` succeeds on your network.
 */
Config.setBrowserExecutable(
  process.env.PACT_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
);
