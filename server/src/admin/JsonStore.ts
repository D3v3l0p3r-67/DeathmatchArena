import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * A small JSON file, written safely.
 *
 * The storage detail behind both repositories, and the only place that knows
 * anything about the filesystem. Swapping either repository for a database means
 * writing a class with the same handful of methods -- nothing above this line
 * knows a file is involved.
 *
 * Writes go to a temporary file and are renamed into place, so a crash halfway
 * through leaves the previous contents intact rather than a truncated file. On
 * an ephemeral container the data is lost with the container, which is exactly
 * why the interface above is async and swappable.
 */
export class JsonStore<T> {
  private readonly filePath: string;

  constructor(directory: string, fileName: string) {
    this.filePath = path.join(directory, fileName);
  }

  get location(): string {
    return this.filePath;
  }

  /** Read the stored value, or `null` when nothing has been stored yet. */
  async read(): Promise<T | null> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as T;
    } catch (error) {
      if (isMissing(error)) return null;
      // A corrupt file is reported rather than silently replaced: losing every
      // arena to a stray byte would be a far worse outcome than refusing to start.
      throw new Error(`Could not read ${this.filePath}: ${describe(error)}`);
    }
  }

  async write(value: T): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
