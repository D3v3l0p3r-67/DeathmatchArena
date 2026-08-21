/** Tiny DOM helpers so UI code stays free of null-checks and casts. */

export function requireElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required UI element: #${id}`);
  return element as T;
}

export function query<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Missing required UI element: ${selector}`);
  return element as T;
}

/** Assign text only when it actually changed, avoiding needless layout work. */
export function setText(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.textContent = value;
}

export function toggleClass(element: HTMLElement, className: string, enabled: boolean): void {
  element.classList.toggle(className, enabled);
}
