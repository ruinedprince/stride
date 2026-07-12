// Saved walks in localStorage (Fase C — memory). Each walk keeps enough of the
// GraphHopper path to redraw and re-navigate offline, plus favorite/rating.
const KEY = "stride.walks";
const CAP = 30;

export function getWalks() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || [];
  } catch {
    return [];
  }
}

function persist(walks) {
  try {
    localStorage.setItem(KEY, JSON.stringify(walks.slice(0, CAP)));
  } catch {
    /* quota — ignore, the walk just won't persist */
  }
}

export function saveWalk(walk) {
  const walks = getWalks();
  walks.unshift(walk);
  persist(walks);
  return walk;
}

export function deleteWalk(id) {
  persist(getWalks().filter((w) => w.id !== id));
}

export function updateWalk(id, patch) {
  persist(getWalks().map((w) => (w.id === id ? { ...w, ...patch } : w)));
}
