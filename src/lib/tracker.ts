export interface Tracker {
  save: number;
  get: number;
  delete: number;
  list: number;
}

export function getTracker(): Tracker {
  return {
    save: 0,
    get: 0,
    delete: 0,
    list: 0,
  };
}
