import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import L from 'leaflet';

// Web build of the map: Leaflet rendered directly in the DOM (no WebView).
// Mirrors components/CourtMap.js so native + web look identical.

const SF = [37.7749, -122.4194];

const BBALL_SVG =
  '<svg viewBox="0 0 100 100" width="100%" height="100%">' +
  '<circle cx="50" cy="50" r="46" fill="#ee7d1b" stroke="#7a3b06" stroke-width="3"/>' +
  '<g fill="none" stroke="#7a3b06" stroke-width="3">' +
  '<line x1="50" y1="6" x2="50" y2="94"/>' +
  '<line x1="6" y1="50" x2="94" y2="50"/>' +
  '<path d="M20,11 C40,33 40,67 20,89"/>' +
  '<path d="M80,11 C60,33 60,67 80,89"/>' +
  '</g></svg>';

function crowdDecoration(level) {
  if (level === 'empty') {
    return '<div class="zzz"><span>z</span><span>z</span><span>z</span></div>';
  }
  if (level === 'packed') {
    return '<div class="flameglow"></div><div class="flame">🔥</div>';
  }
  return '';
}

// Inject Leaflet's CSS + our marker animations once.
function ensureStyles() {
  if (typeof document === 'undefined') return;
  if (!document.getElementById('hoopmap-leaflet-css')) {
    const link = document.createElement('link');
    link.id = 'hoopmap-leaflet-css';
    link.rel = 'stylesheet';
    link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(link);
  }
  if (!document.getElementById('hoopmap-marker-css')) {
    const style = document.createElement('style');
    style.id = 'hoopmap-marker-css';
    style.textContent = `
      .ballwrap { position: relative; width: 26px; height: 26px; }
      .bball { width: 100%; height: 100%; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.45)); }
      .zzz { position: absolute; top: -12px; right: -10px; font: 700 11px/1 -apple-system, sans-serif; color: #4a5a6a; }
      .zzz span { position: absolute; opacity: 0; animation: drift 2.4s ease-in infinite; }
      .zzz span:nth-child(1) { font-size: 9px;  right: 12px; animation-delay: 0s; }
      .zzz span:nth-child(2) { font-size: 11px; right: 6px;  animation-delay: 0.8s; }
      .zzz span:nth-child(3) { font-size: 13px; right: 0;    animation-delay: 1.6s; }
      @keyframes drift { 0% { opacity: 0; transform: translate(0,4px); } 25% { opacity: 1; } 100% { opacity: 0; transform: translate(6px,-14px); } }
      .flameglow { position: absolute; inset: -3px; border-radius: 50%; animation: glow 0.9s ease-in-out infinite alternate; }
      @keyframes glow { from { box-shadow: 0 0 6px 1px rgba(255,140,0,0.65); } to { box-shadow: 0 0 14px 5px rgba(255,40,0,0.95); } }
      .flame { position: absolute; top: -13px; left: 50%; margin-left: -7px; font-size: 13px; transform-origin: 50% 100%; animation: flicker 0.5s ease-in-out infinite alternate; }
      @keyframes flicker { from { transform: scale(0.9) rotate(-4deg); opacity: 0.85; } to { transform: scale(1.12) rotate(4deg); opacity: 1; } }
      .bounce { animation: bounce 0.6s ease-in-out infinite; }
      @keyframes bounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
    `;
    document.head.appendChild(style);
  }
}

const CourtMap = forwardRef(function CourtMap(
  { courts, userLocation, onSelectCourt },
  ref
) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const markersRef = useRef({});
  const userRef = useRef(null);
  const onSelectRef = useRef(onSelectCourt);
  onSelectRef.current = onSelectCourt;

  useEffect(() => {
    ensureStyles();
    const map = L.map(elRef.current, { zoomControl: true }).setView(SF, 12);
    // Drop Leaflet's default "🇺🇦 Leaflet" attribution prefix (the flag in the
    // bottom-right); the tile data credit below is kept to satisfy OSM/CARTO terms.
    map.attributionControl.setPrefix(false);
    L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
      {
        maxZoom: 20,
        subdomains: 'abcd',
        detectRetina: true,
        attribution: '&copy; OpenStreetMap &copy; CARTO',
      }
    ).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    // Container may size after mount — make sure Leaflet measures correctly.
    setTimeout(() => map.invalidateSize(), 0);
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Re-render markers whenever courts (incl. open/crowd) change.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.clearLayers();
    markersRef.current = {};
    courts.forEach((c) => {
      const ball =
        '<div class="bball" style="opacity:' + (c.open ? 1 : 0.45) + '">' + BBALL_SVG + '</div>';
      const bounce = c.crowd === 'moderate' || c.crowd === 'packed' ? ' bounce' : '';
      const icon = L.divIcon({
        className: '',
        html: '<div class="ballwrap' + bounce + '">' + crowdDecoration(c.crowd) + ball + '</div>',
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      });
      const m = L.marker([c.lat, c.lng], { icon }).addTo(layer);
      m.on('click', () => onSelectRef.current && onSelectRef.current(c.id));
      markersRef.current[c.id] = m;
    });
  }, [courts]);

  // User location dot.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (userRef.current) {
      map.removeLayer(userRef.current);
      userRef.current = null;
    }
    if (userLocation) {
      userRef.current = L.circleMarker([userLocation.lat, userLocation.lng], {
        radius: 7,
        color: '#ffffff',
        weight: 3,
        fillColor: '#0a84ff',
        fillOpacity: 1,
      }).addTo(map);
    }
  }, [userLocation]);

  useImperativeHandle(ref, () => ({
    focusCourt(court) {
      mapRef.current && mapRef.current.setView([court.lat, court.lng], 15, { animate: true });
    },
    recenter(loc) {
      mapRef.current && mapRef.current.setView([loc.lat, loc.lng], 14, { animate: true });
    },
  }));

  return (
    <div
      ref={elRef}
      style={{ width: '100%', height: '100%', backgroundColor: '#aadaf0' }}
    />
  );
});

export default CourtMap;
