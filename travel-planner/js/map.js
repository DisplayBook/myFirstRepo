// Leaflet map wrapper. Leaflet is vendored (vendor/leaflet) and loaded on first use.

let leafletPromise = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletPromise) {
    leafletPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/leaflet/leaflet.js';
      s.onload = () => resolve(window.L);
      s.onerror = () => { leafletPromise = null; reject(new Error('Map library failed to load')); };
      document.head.appendChild(s);
    });
  }
  return leafletPromise;
}

let current = null;

/**
 * Draw markers and lines into `el`. Replaces any previous map.
 * markers: [{lat, lon, color, icon, popup (DOM node or string of escaped HTML)}]
 * lines:   [{points: [[lat, lon], ...], color, dash, weight}]
 * Returns { addLine(line), fit() }.
 */
export async function showMap(el, { markers = [], lines = [] }) {
  const L = await loadLeaflet();
  if (current) { current.remove(); current = null; }
  if (!el.isConnected) return null;
  const map = L.map(el, { zoomControl: true, worldCopyJump: true, tap: false });
  current = map;
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const bounds = [];
  const lineLayer = L.layerGroup().addTo(map);
  const addLine = (ln) => {
    if (!ln.points || ln.points.length < 2) return;
    L.polyline(ln.points, { color: ln.color, weight: ln.weight || 4, opacity: 0.85, dashArray: ln.dash || null, lineCap: 'round' })
      .addTo(lineLayer);
  };
  lines.forEach(addLine);

  for (const m of markers) {
    const icon = L.divIcon({
      className: 'pin',
      html: `<span class="pin-dot" style="--c:${m.color}">${m.icon}</span>`,
      iconSize: [32, 32], iconAnchor: [16, 16], popupAnchor: [0, -14],
    });
    const mk = L.marker([m.lat, m.lon], { icon, title: m.title || '', keyboard: true }).addTo(map);
    if (m.popup) mk.bindPopup(m.popup, { maxWidth: 260 });
    bounds.push([m.lat, m.lon]);
  }
  for (const ln of lines) for (const p of ln.points || []) bounds.push(p);

  const fit = () => {
    if (bounds.length === 1) map.setView(bounds[0], 13);
    else if (bounds.length) map.fitBounds(bounds, { padding: [36, 36], maxZoom: 14 });
    else map.setView([30, 0], 2);
  };
  fit();
  // The container may have just been laid out; make sure tiles fill it.
  setTimeout(() => { if (current === map) map.invalidateSize(); }, 60);
  return { addLine, fit, map };
}

export function destroyMap() {
  if (current) { current.remove(); current = null; }
}
