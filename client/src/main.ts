import "./styles.css";
import { App } from "./App.js";
import { clientConfig } from "./config.js";

/**
 * Entry point.
 *
 * Everything interesting lives in `App`; this file only boots it and makes sure
 * browser defaults (page scrolling, drag-select, the context menu) do not fight
 * the controls.
 */

function preventBrowserInterference(): void {
  // Space and the arrow keys scroll the page, but claiming them here would break
  // the game: Phaser's keyboard manager ignores any event whose default has
  // already been prevented, so a listener like this one running first silently
  // swallowed every Space and arrow press. `InputController` calls Phaser's own
  // `addCapture` for exactly these keys instead, which stops the scrolling from
  // inside Phaser's handler -- after the key state has been recorded.
  //
  // It also only applies once a match is joined, so typing a name with a space
  // in it still works on the menu.

  // Dragging to aim must not start a text selection or a native drag.
  document.addEventListener("dragstart", (event) => event.preventDefault());
  document.addEventListener("selectstart", (event) => {
    if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
  });
}

preventBrowserInterference();

console.info(
  `%cDeathmatch Arena%c  server: ${clientConfig.serverUrl}`,
  "color:#37d0ff;font-weight:bold",
  "color:#8fa0be",
);

new App().start();
