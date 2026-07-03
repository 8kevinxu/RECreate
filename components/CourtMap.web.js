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

const VBALL_SVG =
  '<svg viewBox="0 0 100 100" width="100%" height="100%">' +
  '<circle cx="50" cy="50" r="46" fill="#f4f6f8" stroke="#1f5fae" stroke-width="3"/>' +
  '<g fill="none" stroke="#1f5fae" stroke-width="3">' +
  '<path d="M50,5 C34,30 28,55 12,79"/>' +
  '<path d="M50,5 C61,34 71,55 92,69"/>' +
  '<path d="M8,54 C36,55 64,69 79,92"/>' +
  '</g></svg>';

const PPONG_SVG =
  '<svg viewBox="0 0 100 100" width="100%" height="100%">' +
  '<circle cx="42" cy="40" r="34" fill="#d6322f" stroke="#7a1714" stroke-width="3"/>' +
  '<rect x="36" y="68" width="12" height="26" rx="4" fill="#9c6b3b" stroke="#5e3d1d" stroke-width="3"/>' +
  '<circle cx="78" cy="72" r="10" fill="#f4f6f8" stroke="#7a3b06" stroke-width="3"/>' +
  '</svg>';

const PICKLE_SVG =
  '<svg viewBox="0 0 100 100" width="100%" height="100%">' +
  '<rect x="12" y="6" width="54" height="62" rx="20" fill="#1c1c1c" stroke="#000000" stroke-width="3"/>' +
  '<rect x="31" y="62" width="16" height="30" rx="5" fill="#1c1c1c" stroke="#000000" stroke-width="3"/>' +
  '<circle cx="78" cy="74" r="13" fill="#a3e635" stroke="#3f6212" stroke-width="2.5"/>' +
  '<g fill="#3f6212"><circle cx="73" cy="70" r="1.8"/><circle cx="82" cy="71" r="1.8"/><circle cx="76" cy="79" r="1.8"/><circle cx="84" cy="77" r="1.6"/></g>' +
  '</svg>';

const TENNIS_SVG =
  '<svg viewBox="0 0 100 100" width="100%" height="100%">' +
  '<circle cx="50" cy="50" r="46" fill="#c6e94b" stroke="#5a7d14" stroke-width="3"/>' +
  '<g fill="none" stroke="#f4f6f8" stroke-width="4">' +
  '<path d="M16,18 C42,34 42,66 16,82"/>' +
  '<path d="M84,18 C58,34 58,66 84,82"/>' +
  '</g></svg>';

// A steel dumbbell — the rec-center weight room (a facility view, not a sport).
const WEIGHT_SVG =
  '<svg viewBox="0 0 100 100" width="100%" height="100%">' +
  '<rect x="36" y="44" width="28" height="12" rx="2" fill="#9aa4af" stroke="#2b3138" stroke-width="3"/>' +
  '<g fill="#5b6570" stroke="#2b3138" stroke-width="3" stroke-linejoin="round">' +
  '<rect x="12" y="28" width="15" height="44" rx="4"/>' +
  '<rect x="28" y="37" width="11" height="26" rx="3"/>' +
  '<rect x="61" y="37" width="11" height="26" rx="3"/>' +
  '<rect x="73" y="28" width="15" height="44" rx="4"/>' +
  '</g></svg>';

const SPORT_SVG = { basketball: BBALL_SVG, volleyball: VBALL_SVG, pingpong: PPONG_SVG, pickleball: PICKLE_SVG, tennis: TENNIS_SVG, weightroom: WEIGHT_SVG };
const ballSvg = (sport) => SPORT_SVG[sport] || BBALL_SVG;

function crowdDecoration(level) {
  if (level === 'empty') {
    return '<div class="zzz"><span>z</span><span>z</span><span>z</span></div>';
  }
  if (level === 'packed') {
    return '<div class="flameglow"></div><div class="flame">🔥</div>';
  }
  return '';
}

// Reservation occupancy → halo class. null = not reservable / closed now.
function bookLevel(pct) {
  if (pct == null) return null;
  if (pct >= 100) return 'full';
  if (pct >= 75) return 'mostly';
  if (pct >= 40) return 'half';
  if (pct > 0) return 'slight';
  return 'none';
}

// Inject Leaflet's CSS + our marker animations once.
function ensureStyles() {
  if (typeof document === 'undefined') return;
  if (!document.getElementById('recreate-leaflet-css')) {
    const link = document.createElement('link');
    link.id = 'recreate-leaflet-css';
    link.rel = 'stylesheet';
    link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(link);
  }
  if (!document.getElementById('recreate-marker-css')) {
    const style = document.createElement('style');
    style.id = 'recreate-marker-css';
    style.textContent = `
      .ballwrap { position: relative; width: 26px; height: 26px; }
      .bball { position: relative; z-index: 1; width: 100%; height: 100%; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.45)); }
      .bookring { position: absolute; inset: -3px; border-radius: 50%; z-index: 0; }
      .bk-none   { box-shadow: 0 0 6px 2px rgba(46,204,113,0.95); }
      .bk-slight { box-shadow: 0 0 6px 2px rgba(150,200,70,0.95); }
      .bk-half   { box-shadow: 0 0 7px 2px rgba(241,196,15,0.98); }
      .bk-mostly { box-shadow: 0 0 8px 3px rgba(230,126,34,0.98); }
      .bk-full   { box-shadow: 0 0 9px 3px rgba(231,76,60,1); animation: bookflash 0.7s ease-in-out infinite alternate; }
      @keyframes bookflash { from { box-shadow: 0 0 5px 2px rgba(231,76,60,0.45); } to { box-shadow: 0 0 15px 6px rgba(231,76,60,1); } }
      .jump { animation: jump 0.8s ease-in-out infinite; }
      @keyframes jump { 0%, 100% { transform: translateY(0); } 40% { transform: translateY(-4px); } }
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
      .dot { width: 100%; height: 100%; border-radius: 50%; background: #8a97a5; border: 1.5px solid #fff; opacity: 0.6; box-shadow: 0 1px 2px rgba(0,0,0,0.3); }
      .clus { display: flex; align-items: center; justify-content: center; border-radius: 50%; font: 700 13px/1 -apple-system, sans-serif; color: #fff; border: 2px solid #fff; box-shadow: 0 2px 6px rgba(0,0,0,0.35); }
      .clus.has-open { background: #ee7d1b; }
      .clus.no-open { background: #9aa4af; }
    `;
    document.head.appendChild(style);
  }
}

// Zoomed-out courts are grouped into count bubbles (grid-clustered by screen
// distance) so dense areas — basketball especially — don't wall off the map;
// zoom past DECLUSTER_ZOOM and every court shows on its own.
const CLUSTER_RADIUS = 55; // px: courts closer than this on screen group together
const DECLUSTER_ZOOM = 16; // at/after this zoom, always show individual courts

function individualIcon(c, sport) {
  // Open now → full sport ball with its crowd/booking decorations.
  if (c.open) {
    const size = c.indoor === false ? 22 : 26;
    // A court may carry its own sport (Favorites view glyphs each pin by the sport
    // it was favorited for); otherwise fall back to the map-wide sport.
    const ball = '<div class="bball">' + ballSvg(c.sport || sport) + '</div>';
    const level = bookLevel(c.booked);
    const ring = level ? '<div class="bookring bk-' + level + '"></div>' : '';
    const anim = level === 'full' ? ' jump' : c.crowd === 'moderate' || c.crowd === 'packed' ? ' bounce' : '';
    return L.divIcon({
      className: '',
      html:
        '<div class="ballwrap' + anim + '" style="width:' + size + 'px;height:' + size + 'px">' +
        crowdDecoration(c.crowd) + ring + ball + '</div>',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
  }
  // Closed / no drop-in now → small faded dot.
  return L.divIcon({ className: '', html: '<div class="dot"></div>', iconSize: [13, 13], iconAnchor: [6.5, 6.5] });
}

function addCluster(map, layer, group) {
  let anyOpen = false;
  let sumLat = 0;
  let sumLng = 0;
  const n = group.length;
  for (const c of group) {
    if (c.open) anyOpen = true;
    sumLat += c.lat;
    sumLng += c.lng;
  }
  const d = 26 + Math.min(18, Math.round(Math.log2(n) * 7)); // grows with count
  const icon = L.divIcon({
    className: '',
    html:
      '<div class="clus ' + (anyOpen ? 'has-open' : 'no-open') + '" style="width:' + d + 'px;height:' + d + 'px">' + n + '</div>',
    iconSize: [d, d],
    iconAnchor: [d / 2, d / 2],
  });
  const mk = L.marker([sumLat / n, sumLng / n], { icon }).addTo(layer);
  const bounds = L.latLngBounds(group.map((c) => [c.lat, c.lng]));
  mk.on('click', () => map.fitBounds(bounds.pad(0.3), { maxZoom: DECLUSTER_ZOOM }));
}

// Render markers for the current zoom: individual pins past DECLUSTER_ZOOM,
// otherwise grid-bucketed into lone pins + cluster bubbles. Returns the id→marker
// map (for focusCourt). onSelect fires when an individual court is tapped.
function renderMarkers(map, layer, courts, sport, onSelect) {
  layer.clearLayers();
  const markers = {};
  const addIndividual = (c) => {
    const mk = L.marker([c.lat, c.lng], { icon: individualIcon(c, sport) }).addTo(layer);
    mk.on('click', () => onSelect(c.id));
    markers[c.id] = mk;
  };
  if (map.getZoom() >= DECLUSTER_ZOOM) {
    courts.forEach(addIndividual);
    return markers;
  }
  const buckets = {};
  courts.forEach((c) => {
    const p = map.latLngToLayerPoint([c.lat, c.lng]);
    const key = Math.round(p.x / CLUSTER_RADIUS) + '_' + Math.round(p.y / CLUSTER_RADIUS);
    (buckets[key] = buckets[key] || []).push(c);
  });
  Object.values(buckets).forEach((g) => {
    if (g.length === 1) addIndividual(g[0]);
    else addCluster(map, layer, g);
  });
  return markers;
}

const CourtMap = forwardRef(function CourtMap(
  { courts, sport = 'basketball', userLocation, onSelectCourt },
  ref
) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const markersRef = useRef({});
  const userRef = useRef(null);
  const onSelectRef = useRef(onSelectCourt);
  onSelectRef.current = onSelectCourt;
  // Latest courts/sport for the zoomend re-cluster handler (registered once).
  const courtsRef = useRef(courts);
  const sportRef = useRef(sport);

  useEffect(() => {
    ensureStyles();
    // No +/- buttons (pinch/scroll to zoom). zoomSnap 0 keeps zoom continuous;
    // attribution control hidden for a clean map.
    const map = L.map(elRef.current, {
      zoomControl: false,
      attributionControl: false,
      zoomSnap: 0,
      zoomDelta: 0.4,
      wheelPxPerZoomLevel: 90,
    }).setView(SF, 12);
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
    // Re-cluster on zoom (grouping is a function of zoom + geography, so panning
    // needs no rebuild — the geo-anchored markers just move with the map).
    map.on('zoomend', () => {
      markersRef.current = renderMarkers(
        map,
        layerRef.current,
        courtsRef.current,
        sportRef.current,
        (id) => onSelectRef.current && onSelectRef.current(id)
      );
    });
    // Container may size after mount — make sure Leaflet measures correctly.
    setTimeout(() => map.invalidateSize(), 0);
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Re-render markers whenever courts (incl. open/crowd) change.
  useEffect(() => {
    courtsRef.current = courts;
    sportRef.current = sport;
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    markersRef.current = renderMarkers(
      map,
      layer,
      courts,
      sport,
      (id) => onSelectRef.current && onSelectRef.current(id)
    );
  }, [courts, sport]);

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
      const map = mapRef.current;
      if (!map) return;
      // Shift the map center below the marker so the pin sits in the visible
      // area above the court detail card (which covers the bottom of the screen).
      // Zoom to the decluster level so the court resolves to its own pin.
      const z = DECLUSTER_ZOOM;
      const offsetY = Math.round(map.getSize().y * 0.25);
      const center = map.unproject(map.project([court.lat, court.lng], z).add([0, offsetY]), z);
      map.setView(center, z, { animate: true });
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
