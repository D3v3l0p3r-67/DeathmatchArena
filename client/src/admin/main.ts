/**
 * The administration interface's entry point.
 *
 * A separate page from the game on purpose: it shares the configuration and
 * arena models through `@deathmatch/shared` and nothing else. No Phaser, no
 * Colyseus, no game code -- which is what keeps a mistake here from being able
 * to break a match.
 */
import "../styles.css";
import "./admin.css";
import { AdminApp } from "./AdminApp.js";

const root = document.getElementById("admin-root");
if (!root) throw new Error("The admin page is missing its root element.");

const app = new AdminApp(root);
void app.start();
