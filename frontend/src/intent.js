// Objectives / moods — one-tap shortcuts that translate "how do you want to
// walk today" into concrete settings (distance + preference + hour), reusing
// the same controls the user would set by hand.
export const MOODS = [
  { id: "relax", icon: "🍃", label: "Relaxar", km: 4, pref: "green", hint: "passo tranquilo pelo verde" },
  { id: "treino", icon: "🔥", label: "Treino", km: 9, pref: "none", hint: "volta longa pra puxar o ritmo" },
  { id: "explorar", icon: "🧭", label: "Explorar", km: 6, pref: "none", shuffle: true, hint: "ruas novas pra descobrir" },
  { id: "cachorro", icon: "🐕", label: "Com o cão", km: 3, pref: "green", hint: "curta e sombreada pelas praças" },
  { id: "foto", icon: "📸", label: "Fotografia", km: 5, pref: "shade", hour: 16, hint: "luz dourada do fim de tarde" },
];
