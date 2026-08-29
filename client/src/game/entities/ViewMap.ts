/**
 * A collection of views kept in step with a collection of state.
 *
 * The client draws six kinds of entity, and every one of them needs the same
 * three motions: make a view when an id first appears, update it while the id
 * lives, destroy it when the id is gone. Written out by hand that is a dozen
 * lines per entity type, and the campaign scene alone repeated it six times --
 * with the prune loop being exactly the part that gets forgotten, which is how
 * crates once stayed drawn where the simulation no longer had them.
 *
 * The state side is anything Map-shaped: a Colyseus `MapSchema` from the
 * network and a plain `Map` from the local simulation both fit.
 */

/** What `sync` reads: iteration plus membership, nothing more. */
export interface LiveEntities<TState> extends Iterable<[string, TState]> {
  has(id: string): boolean;
}

export class ViewMap<TState, TView extends { destroy(): void }> {
  private readonly views = new Map<string, TView>();

  get size(): number {
    return this.views.size;
  }

  get(id: string): TView | undefined {
    return this.views.get(id);
  }

  values(): IterableIterator<TView> {
    return this.views.values();
  }

  /**
   * One pass: create what is new, update everything alive, destroy what is
   * gone. `update` also runs on the frame a view is created, so a view never
   * renders in its constructor-default state.
   */
  sync(
    live: LiveEntities<TState>,
    create: (state: TState, id: string) => TView,
    update: (view: TView, state: TState, id: string) => void,
    onRemoved?: (id: string) => void,
  ): void {
    for (const [id, state] of live) {
      let view = this.views.get(id);
      if (!view) {
        view = create(state, id);
        this.views.set(id, view);
      }
      update(view, state, id);
    }
    for (const [id, view] of this.views) {
      if (live.has(id)) continue;
      view.destroy();
      this.views.delete(id);
      onRemoved?.(id);
    }
  }

  /** Scene teardown: every view destroyed, the collection empty. */
  destroyAll(): void {
    for (const view of this.views.values()) view.destroy();
    this.views.clear();
  }
}
