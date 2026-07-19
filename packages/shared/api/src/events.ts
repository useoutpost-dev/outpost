export interface EventRecord {
  id: number;
  /** Unix epoch milliseconds */
  ts: number;
  kind: string;
  sandboxId: string | null;
  payload: unknown;
}

export interface EventsListResponse {
  events: EventRecord[];
  total: number;
}
