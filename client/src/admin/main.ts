/**
 * The administration interface's entry point.
 *
 * A separate page from the game on purpose: it shares the configuration and
 * arena models through `@deathmatch/shared` and nothing else. No Phaser, no
 * Colyseus, no game code -- which is what keeps a mistake here from being able
 * to break a match.
 *
 * That includes the stylesheet. The game's locks the document at `height: 100%;
 * overflow: hidden` and forbids text selection, which is exactly right for a
 * canvas that must never scroll and exactly wrong for a page of settings.
 */
import "./admin.css";
import { AdminApp } from "./AdminApp.js";

const root = document.getElementById("admin-root");
if (!root) throw new Error("The admin page is missing its root element.");

const app = new AdminApp(root);
void app.start();
