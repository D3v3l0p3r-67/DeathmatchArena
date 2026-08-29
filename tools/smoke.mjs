/**
 * The checks a unit test cannot make.
 *
 * Everything in `tests/` runs the simulation in Node, which is exactly why it
 * missed the two worst faults of the last round: modals that drew perfectly
 * and swallowed no clicks because `#ui-root` is `pointer-events: none`, and a
 * pause menu that closed while leaving the game frozen behind it. Neither is
 * visible without a real browser pressing real buttons.
 *
 * So this drives the built game in Chromium: the menus, every picker, a
 * campaign level, the pause cycle and the settings panel. It is deliberately a
 * *smoke* suite -- broad and shallow, a few seconds per flow -- because its job
 * is to prove the thing is wired together, not to re-test the physics.
 *
 *   npm run smoke
 *
 * Serves the built client from the game server itself, so there is one origin,
 * one process to wait for and nothing to keep in sync with a dev server.
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = Number(process.env.SMOKE_PORT ?? 2599);
const ORIGIN = `http://localhost:${PORT}`;
/** Where CI's browser lives when the sandbox has pre-installed one. */
const EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM ?? undefined;

const failures = [];
let checks = 0;

function check(condition, description, detail = "") {
  checks++;
  if (condition) {
    console.log(`  ok   ${description}`);
    return true;
  }
  console.log(`  FAIL ${description}${detail ? ` — ${detail}` : ""}`);
  failures.push(description);
  return false;
}

async function waitForServer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${ORIGIN}/health`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not answer on ${ORIGIN} in time`);
}

const server = spawn("node", ["server/build/index.js"], {
  env: { ...process.env, PORT: String(PORT), SERVE_CLIENT: "true", VERBOSE_LOGGING: "false" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", () => {});
server.stderr.on("data", (chunk) => process.stderr.write(chunk));

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ executablePath: EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  // Anything thrown or logged as an error is a failure in its own right.
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });

  // -------------------------------------------------------------------------
  console.log("\nmain menu");
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  check(await page.isVisible("#play-button"), "the menu offers Play");
  check(await page.isVisible("#campaign-button"), "the menu offers Campaign");

  await page.fill("#name-input", "Smoke");
  await page.keyboard.press("ArrowDown");
  const focused = await page.evaluate(() => document.activeElement?.id ?? "");
  check(focused === "play-button", "arrow keys move focus out of the name field", `focus was "${focused}"`);

  // -------------------------------------------------------------------------
  console.log("\nlobby and its pickers");
  await page.click("#play-button");
  await page.waitForSelector('[data-screen="lobby"].is-active', { timeout: 20_000 });
  await page.waitForTimeout(500);

  const startBefore = await page.evaluate(() => Math.round(document.getElementById("start-match").getBoundingClientRect().top));
  check(
    (await page.textContent("#start-blocker")).length > 0,
    "a disabled Start says why it cannot be pressed",
  );

  // The regression that mattered: a picker must not move the layout, and its
  // options must actually take a click.
  await page.click("#add-bot");
  await page.waitForTimeout(300);
  const startDuring = await page.evaluate(() => Math.round(document.getElementById("start-match").getBoundingClientRect().top));
  check(startBefore === startDuring, "opening a picker does not move the panel", `${startBefore} then ${startDuring}`);

  await page.click('#bot-picker-options button[data-level="3"]', { timeout: 5_000 });
  await page.waitForTimeout(400);
  const roster = await page.$$eval("#lobby-players li", (rows) => rows.length);
  check(roster === 2, "clicking a bot difficulty actually adds the bot", `roster had ${roster} rows`);

  await page.click("#change-mode");
  await page.click('#mode-picker-options button[data-mode="flagHunt"]', { timeout: 5_000 });
  await page.waitForTimeout(400);
  check((await page.textContent("#lobby-mode-name")).trim() === "Flag Hunt", "the mode picker changes the mode");

  await page.click("#change-map");
  await page.waitForTimeout(300);
  const selectedMaps = await page.$$eval("#map-picker-options .is-selected", (els) => els.length);
  check(selectedMaps === 1, "the map picker marks exactly the map in use", `${selectedMaps} marked`);
  await page.click("#map-picker-cancel");

  // -------------------------------------------------------------------------
  console.log("\ncampaign, pause and resume");
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await page.fill("#name-input", "Smoke");
  await page.click("#campaign-button");
  await page.waitForSelector('[data-screen="campaign"].is-active');

  const difficulties = await page.$$eval("#campaign-difficulty .is-selected", (els) => els.length);
  check(difficulties === 1, "exactly one difficulty reads as chosen", `${difficulties} looked chosen`);

  await page.click("#campaign-start");
  await page.waitForTimeout(3_000);
  const running = await page.evaluate(() => document.querySelector('[data-layer="campaign"]')?.classList.contains("is-active"));
  check(running === true, "starting a level puts the campaign HUD up");

  // Escape must pause rather than quit, twice in a row -- the soft-lock.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check(await page.evaluate(() => document.getElementById("pause-menu").classList.contains("is-active")), "Escape pauses");

  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check(
    !(await page.evaluate(() => document.getElementById("pause-menu").classList.contains("is-active"))),
    "Escape again resumes",
  );

  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check(
    await page.evaluate(() => document.getElementById("pause-menu").classList.contains("is-active")),
    "the pause menu can be reopened after resuming",
  );

  // Quitting asks first, and cancelling leaves the run alone.
  await page.click("#pause-quit", { timeout: 5_000 });
  await page.waitForTimeout(400);
  check(
    await page.evaluate(() => document.getElementById("confirm-dialog").classList.contains("is-active")),
    "quitting a run asks for confirmation",
  );
  await page.click("#confirm-cancel");
  await page.waitForTimeout(300);
  check(
    await page.evaluate(() => document.getElementById("pause-menu").classList.contains("is-active")),
    "cancelling returns to the pause menu",
  );

  // -------------------------------------------------------------------------
  console.log("\nsettings");
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await page.click("#menu-settings-button");
  await page.waitForTimeout(400);
  check(
    await page.evaluate(() => document.querySelector('[data-tab-panel="effects"]').hidden),
    "only the selected settings tab is shown",
  );

  await page.click('.settings__tab[data-tab="controls"]');
  await page.waitForTimeout(300);
  const bindings = await page.$$eval("#controls-list dt", (rows) => rows.length);
  check(bindings > 5, "the controls tab lists the bindings", `${bindings} rows`);

  await page.click('.settings__tab[data-tab="audio"]');
  await page.evaluate(() => {
    const slider = document.getElementById("setting-music");
    slider.value = "90";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(200);
  const label = await page.textContent("#setting-music-value");
  check(label.trim() === "90%", "a slider's percentage follows the slider", `label read "${label}"`);

  await page.click("#settings-reset");
  await page.waitForTimeout(300);
  const reset = await page.evaluate(() => document.getElementById("setting-music").value);
  check(reset === "45", "reset to defaults puts a changed setting back", `value was ${reset}`);

  // -------------------------------------------------------------------------
  check(pageErrors.length === 0, "nothing threw or logged an error", pageErrors.slice(0, 3).join(" | "));
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length > 0) {
  console.log("failed:");
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
