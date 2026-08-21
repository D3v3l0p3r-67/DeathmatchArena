/**
 * Minimal typed event emitter.
 *
 * Keeps the network layer decoupled from Phaser and from the DOM UI: both simply
 * subscribe to the events they care about.
 */
/** Any object type works as an event map; keys are event names. */
export type EventMap = object;

type Handler<T> = (payload: T) => void;

export class Emitter<TEvents extends EventMap> {
  private readonly handlers = new Map<keyof TEvents, Set<Handler<never>>>();

  on<K extends keyof TEvents>(event: K, handler: Handler<TEvents[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => this.off(event, handler);
  }

  off<K extends keyof TEvents>(event: K, handler: Handler<TEvents[K]>): void {
    this.handlers.get(event)?.delete(handler as Handler<never>);
  }

  emit<K extends keyof TEvents>(event: K, payload: TEvents[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    // Copy so a handler unsubscribing during dispatch cannot break iteration.
    for (const handler of Array.from(set)) (handler as Handler<TEvents[K]>)(payload);
  }

  clear(): void {
    this.handlers.clear();
  }
}
