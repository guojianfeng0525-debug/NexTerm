/**
 * Nexterm cross-component event contract.
 *
 * The toolbox views (Postgres / SQLite / MySQL query tools, notes, shell
 * terminal) coordinate through `window` CustomEvents. This file documents the
 * canonical event names and their `detail` shapes so dispatchers and
 * listeners stay in sync. Code references these types where practical; legacy
 * dispatches without a provider field remain supported by every listener.
 */

/** Every Nexterm window event, keyed by event name with its detail type. */
export interface NextermToolboxEventMap {
  /** Postgres SQL editor pastes a note into the active query tab. */
  'nexterm:paste-sql-note': {
    content: string;
    /** Marks the event as handled once a listener applied it. */
    handled?: boolean;
    /** Emitted by the notes tool as "postgres"; handlers gate on their own
     *  provider so only the matching query tool responds. */
    provider?: string;
  };

  /** Shell terminal pastes a note into the active terminal. */
  'nexterm:paste-shell-note': {
    content: string;
    handled?: boolean;
  };

  /** Notes → Postgres: open a new query tab for a connection with content. */
  'nexterm:paste-sql-to-query': {
    content: string;
    connectionId: string;
    /** Source note title used as the new tab title. */
    sourceTitle?: string;
  };

  /** Notes → Postgres: run a note's SQL against a connection. */
  'nexterm:quick-execute-postgres': {
    content: string;
    connectionId: string;
  };

  /** Select a note by id; App.tsx switches to the notes section too. */
  'nexterm:select-note': {
    noteId: string;
  };

  /** Ask the notes view to flush pending debounced edits immediately. */
  'nexterm:toolbox-flush-request': Record<string, never>;

  /** Toolbox data changed (apps/tunnels/services/notes/connections). */
  'nexterm:toolbox-changed': {
    kind?: string;
  };

  /** A database provider was picked from the provider select. */
  'nexterm:database-provider-selected': string;
}

/** Global augmentation so `CustomEvent<T>` types match at the call sites. */
export type NextermToolboxEventName = keyof NextermToolboxEventMap;

export function isNextermToolboxEvent<K extends NextermToolboxEventName>(
  event: Event,
  name: K,
): event is CustomEvent<NextermToolboxEventMap[K]> {
  return event.type === name;
}
