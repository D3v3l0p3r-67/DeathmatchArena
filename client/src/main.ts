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
  // Space and the arrow keys scroll the page unless we claim them.
  window.addEventListener(
    "keydown",
    (event) => {
      const isTypingInInput = event.target instanceof HTMLInputElement;
      if (isTypingInInput) return;

      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)) {
        event.preventDefault();
      }
    },
    { passive: false },
  );

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
