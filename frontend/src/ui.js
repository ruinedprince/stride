// Small DOM/formatting helpers shared across modules.

const statusEl = document.getElementById("status");

export function setStatus(html, kind) {
  statusEl.className = kind || "";
  statusEl.innerHTML = html;
}

export function fmtKm(meters) {
  return `${(meters / 1000).toFixed(2).replace(".", ",")} km`;
}

export function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}

export function fmtHour(h) {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return mm === 0 ? `${hh}h` : `${hh}h${String(mm).padStart(2, "0")}`;
}

export function setBusy(btn, busy) {
  btn.disabled = busy;
  btn.classList.toggle("is-busy", busy);
}
