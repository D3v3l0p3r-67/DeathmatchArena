import { AdminApi, AdminApiError } from "./AdminApi.js";
import { ArenaPanel } from "./ArenaPanel.js";
import { CampaignPanel } from "./CampaignPanel.js";
import { ConfigPanel, button, describe } from "./ConfigPanel.js";

type Tab = "arenas" | "campaign" | "config";

/**
 * The administration interface.
 *
 * A sign-in, two tabs and a status line. Everything of substance is in the two
 * panels; this holds the token, decides which panel is on screen, and keeps one
 * place for messages so the panels never invent their own.
 *
 * The sign-in is not a security boundary and does not pretend to be one. It is a
 * place to put the token so the interface can stop guessing. Every request is
 * checked by the server, and this page would be just as useless without it.
 */
export class AdminApp {
  private readonly api = new AdminApi();
  private readonly root: HTMLElement;
  private readonly content = document.createElement("main");
  private readonly status = document.createElement("div");

  private readonly configPanel: ConfigPanel;
  private readonly arenaPanel: ArenaPanel;
  private readonly campaignPanel: CampaignPanel;

  private tab: Tab = "arenas";
  private signedIn = false;
  private persistent = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.content.className = "content";
    this.status.className = "status";

    const notify = (message: string, tone: "info" | "error" | "success") => this.notify(message, tone);
    this.configPanel = new ConfigPanel(this.api, { notify });
    this.arenaPanel = new ArenaPanel(this.api, { notify });
    this.campaignPanel = new CampaignPanel(this.api, { notify });

    // A half-drawn arena is worth a browser's "are you sure": the alternative is
    // losing an afternoon's level design to a stray Cmd-W.
    window.addEventListener("beforeunload", (event) => {
      if (!this.arenaPanel.isDirty && !this.campaignPanel.isDirty) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }

  /** Try the stored token; fall back to the sign-in form. */
  async start(): Promise<void> {
    this.render();

    if (!this.api.hasToken) {
      this.renderSignIn();
      return;
    }

    try {
      const session = await this.api.session();
      this.persistent = session.persistent;
      this.signedIn = true;
      await this.showTab(this.tab);
    } catch (error) {
      // A stored token that no longer works is worth clearing, or every reload
      // would fail the same way with no obvious cause.
      if (error instanceof AdminApiError && error.status === 401) this.api.clearToken();
      this.renderSignIn(error instanceof AdminApiError ? error.message : undefined);
    }
  }

  // -------------------------------------------------------------------------

  private render(): void {
    const header = document.createElement("header");
    header.className = "shell__header";

    const title = document.createElement("h1");
    title.className = "shell__title";
    title.textContent = "Deathmatch Arena — Administration";

    const tabs = document.createElement("nav");
    tabs.className = "shell__tabs";

    if (this.signedIn) {
      tabs.append(
        this.tabButton("Arenas", "arenas"),
        this.tabButton("Campaign levels", "campaign"),
        this.tabButton("Game configuration", "config"),
        button("Sign out", "ghost small", () => this.signOut()),
      );
    }

    header.append(title, tabs);
    this.root.replaceChildren(header, this.status, this.content);

    if (this.signedIn && !this.persistent) {
      this.notify(
        "This server stores administration data where it may not survive a restart. Changes apply immediately, but back up anything you care about.",
        "info",
      );
    }
  }

  private tabButton(label: string, tab: Tab): HTMLButtonElement {
    const element = button(label, "tab", () => void this.showTab(tab));
    element.classList.toggle("is-active", this.tab === tab);
    return element;
  }

  private renderSignIn(message?: string): void {
    this.signedIn = false;
    this.render();

    const form = document.createElement("form");
    form.className = "signin";

    const heading = document.createElement("h2");
    heading.textContent = "Access token";

    const explanation = document.createElement("p");
    explanation.className = "signin__note";
    explanation.textContent =
      "Use one of the server's configured tokens (DEBUG_TOKENS). The server checks it on every request.";

    const input = document.createElement("input");
    input.type = "password";
    input.className = "signin__input";
    input.placeholder = "Token";
    input.autocomplete = "current-password";

    const remember = document.createElement("label");
    remember.className = "signin__remember";
    const rememberInput = document.createElement("input");
    rememberInput.type = "checkbox";
    rememberInput.checked = true;
    remember.append(rememberInput, document.createTextNode("Remember on this browser"));

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "button button--primary";
    submit.textContent = "Sign in";

    const error = document.createElement("p");
    error.className = "signin__error";
    if (message) error.textContent = message;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "";
      this.api.setToken(input.value, rememberInput.checked);

      try {
        const session = await this.api.session();
        this.persistent = session.persistent;
        this.signedIn = true;
        this.render();
        await this.showTab(this.tab);
      } catch (caught) {
        this.api.clearToken();
        error.textContent = describe(caught);
      }
    });

    form.append(heading, explanation, input, remember, submit, error);
    this.content.replaceChildren(form);
    input.focus();
  }

  private async showTab(tab: Tab): Promise<void> {
    this.tab = tab;
    this.render();

    try {
      if (tab === "config") {
        await this.configPanel.load();
        this.content.replaceChildren(this.configPanel.element);
      } else if (tab === "campaign") {
        await this.campaignPanel.load();
        this.content.replaceChildren(this.campaignPanel.element);
      } else {
        await this.arenaPanel.load();
        this.content.replaceChildren(this.arenaPanel.element);
      }
    } catch (error) {
      if (error instanceof AdminApiError && error.status === 401) {
        this.api.clearToken();
        this.renderSignIn("That token is no longer accepted.");
        return;
      }
      this.notify(describe(error), "error");
    }
  }

  private signOut(): void {
    if (
      (this.arenaPanel.isDirty || this.campaignPanel.isDirty) &&
      !window.confirm("Discard unsaved changes and sign out?")
    )
      return;
    this.api.clearToken();
    this.tab = "arenas";
    this.renderSignIn();
  }

  private notify(message: string, tone: "info" | "error" | "success"): void {
    this.status.className = `status status--${tone}`;
    this.status.textContent = message;
    this.status.classList.toggle("is-visible", message.length > 0);
  }
}
