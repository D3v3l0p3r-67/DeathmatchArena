import type {
  ArenaDefinition,
  ArenaIssue,
  ConfigFieldDefinition,
  ConfigValue,
  TrapTypeDefinition,
  ValidationIssue,
} from "@deathmatch/shared";

/** One configurable value, as the server reports it. */
export interface ConfigField extends ConfigFieldDefinition {
  value: ConfigValue;
  /** True when this differs from the default and can be reset. */
  overridden: boolean;
}

export interface ArenaSummary {
  id: string;
  name: string;
  enabled: boolean;
  width: number;
  height: number;
  elementCount: number;
  playerSpawnCount: number;
  powerUpSpawnCount: number;
  trapCount: number;
  updatedAt: number;
}

export interface ConfigSnapshot {
  categories: { category: string; subcategories: string[] }[];
  fields: ConfigField[];
}

export interface ConfigWriteResult {
  ok: boolean;
  issues: ValidationIssue[];
  fields: ConfigField[];
}

export interface ArenaWriteResult {
  ok: boolean;
  issues: ArenaIssue[];
  arena?: ArenaDefinition;
}

/** Thrown for anything the server refused. Carries the status so 401 can be special. */
export class AdminApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

const TOKEN_STORAGE_KEY = "deathmatch-arena:admin-token";

/**
 * The administration API, as the browser sees it.
 *
 * Thin on purpose. Every rule -- what a value may be, whether an arena is
 * sound, who may write anything at all -- lives on the server, and this file
 * knows none of it. What the interface does with a rejection is show it.
 *
 * The token is held here and sent as a bearer header on every request. It is
 * kept in `localStorage` so a reload does not mean typing it again; that is a
 * convenience for whoever already has it, not a security boundary. The boundary
 * is the check the server runs on each request.
 */
export class AdminApi {
  private token = "";

  constructor(private readonly baseUrl = "/admin/api") {
    this.token = readStoredToken();
  }

  get hasToken(): boolean {
    return this.token.length > 0;
  }

  setToken(token: string, remember: boolean): void {
    this.token = token.trim();
    if (!remember) {
      forgetToken();
      return;
    }
    try {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, this.token);
    } catch {
      // Private browsing, or storage disabled. The token still works this session.
    }
  }

  clearToken(): void {
    this.token = "";
    forgetToken();
  }

  /** Check the token before showing anything. Returns whether storage persists. */
  async session(): Promise<{ persistent: boolean }> {
    const result = await this.request<{ persistent: boolean }>("GET", "/session");
    return { persistent: result.persistent === true };
  }

  // -- Configuration ---------------------------------------------------------

  async loadConfig(): Promise<ConfigSnapshot> {
    return this.request<ConfigSnapshot>("GET", "/config");
  }

  async saveConfig(changes: Record<string, ConfigValue>): Promise<ConfigWriteResult> {
    return this.request<ConfigWriteResult>("PUT", "/config", { changes }, true);
  }

  /**
   * Reset one parameter, one subcategory, or a whole category.
   *
   * The scope is whatever is passed: a key resets that value, a category and
   * subcategory reset that section, a category alone resets all of it, and
   * nothing at all resets everything.
   */
  async resetConfig(scope: { key?: string; category?: string; subcategory?: string }): Promise<ConfigWriteResult> {
    return this.request<ConfigWriteResult>("POST", "/config/reset", scope, true);
  }

  // -- Arenas ----------------------------------------------------------------

  async listArenas(): Promise<ArenaSummary[]> {
    const result = await this.request<{ arenas: ArenaSummary[] }>("GET", "/arenas");
    return result.arenas;
  }

  async loadArena(id: string): Promise<ArenaDefinition> {
    const result = await this.request<{ arena: ArenaDefinition }>("GET", `/arenas/${encodeURIComponent(id)}`);
    return result.arena;
  }

  async createArena(name: string, width: number, height: number): Promise<ArenaWriteResult> {
    return this.request<ArenaWriteResult>("POST", "/arenas", { name, width, height }, true);
  }

  async saveArena(id: string, arena: ArenaDefinition): Promise<ArenaWriteResult> {
    return this.request<ArenaWriteResult>("PUT", `/arenas/${encodeURIComponent(id)}`, { arena }, true);
  }

  async checkArena(id: string, arena: ArenaDefinition): Promise<ArenaWriteResult> {
    return this.request<ArenaWriteResult>("POST", `/arenas/${encodeURIComponent(id)}/check`, { arena }, true);
  }

  async duplicateArena(id: string): Promise<ArenaWriteResult> {
    return this.request<ArenaWriteResult>("POST", `/arenas/${encodeURIComponent(id)}/duplicate`, {}, true);
  }

  async setArenaEnabled(id: string, enabled: boolean): Promise<ArenaWriteResult> {
    return this.request<ArenaWriteResult>("POST", `/arenas/${encodeURIComponent(id)}/enabled`, { enabled }, true);
  }

  async deleteArena(id: string): Promise<{ ok: boolean; message: string }> {
    return this.request<{ ok: boolean; message: string }>(
      "DELETE",
      `/arenas/${encodeURIComponent(id)}`,
      undefined,
      true,
    );
  }

  async trapTypes(): Promise<TrapTypeDefinition[]> {
    const result = await this.request<{ types: TrapTypeDefinition[] }>("GET", "/trap-types");
    return result.types;
  }

  // -------------------------------------------------------------------------

  /**
   * One request.
   *
   * `allowRejected` is for the routes that answer a refusal with a body worth
   * reading -- a list of validation problems is the *result*, not an error, and
   * turning it into a thrown exception would lose it.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    allowRejected = false,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new AdminApiError("Could not reach the server.", 0);
    }

    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (response.ok) return payload as T;
    if (allowRejected && response.status === 400) return payload as T;

    const message = typeof payload.message === "string" ? payload.message : response.statusText;
    throw new AdminApiError(message || "The request failed.", response.status);
  }
}

function readStoredToken(): string {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function forgetToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}
