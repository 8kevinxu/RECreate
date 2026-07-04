import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import { useI18n } from '../lib/i18n';

// San Francisco center, used as the initial map view.
const SF_CENTER = { lat: 37.7749, lng: -122.4194 };

// Leaflet + OpenStreetMap rendered inside a WebView. No API key required.
// We use circleMarkers (pure vector) so there are no broken marker-image paths.
const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    html, body, #map { height: 100%; margin: 0; padding: 0; }
    .leaflet-container { background: #aadaf0; }
    .ballwrap { position: relative; width: 26px; height: 26px; }
    .bball {
      position: relative;
      z-index: 1;
      width: 100%;
      height: 100%;
      filter: drop-shadow(0 1px 2px rgba(0,0,0,0.45));
    }

    /* Reservation occupancy halo, green (free) → red (full). Behind the ball. */
    .bookring { position: absolute; inset: -3px; border-radius: 50%; z-index: 0; }
    .bk-none   { box-shadow: 0 0 6px 2px rgba(46,204,113,0.95); }
    .bk-slight { box-shadow: 0 0 6px 2px rgba(150,200,70,0.95); }
    .bk-half   { box-shadow: 0 0 7px 2px rgba(241,196,15,0.98); }
    .bk-mostly { box-shadow: 0 0 8px 3px rgba(230,126,34,0.98); }
    .bk-full   { box-shadow: 0 0 9px 3px rgba(231,76,60,1); animation: bookflash 0.7s ease-in-out infinite alternate; }
    @keyframes bookflash {
      from { box-shadow: 0 0 5px 2px rgba(231,76,60,0.45); }
      to   { box-shadow: 0 0 15px 6px rgba(231,76,60,1); }
    }

    /* Fully booked → the ball hops in place. */
    .jump { animation: jump 0.8s ease-in-out infinite; }
    @keyframes jump {
      0%, 100% { transform: translateY(0); }
      40%      { transform: translateY(-4px); }
    }

    /* Empty → sleepy "z z z" drifting up from the ball. */
    .zzz {
      position: absolute; top: -12px; right: -10px;
      font: 700 11px/1 -apple-system, sans-serif; color: #4a5a6a;
    }
    .zzz span { position: absolute; opacity: 0; animation: drift 2.4s ease-in infinite; }
    .zzz span:nth-child(1) { font-size: 9px;  right: 12px; animation-delay: 0s; }
    .zzz span:nth-child(2) { font-size: 11px; right: 6px;  animation-delay: 0.8s; }
    .zzz span:nth-child(3) { font-size: 13px; right: 0;    animation-delay: 1.6s; }
    @keyframes drift {
      0%   { opacity: 0; transform: translate(0, 4px); }
      25%  { opacity: 1; }
      100% { opacity: 0; transform: translate(6px, -14px); }
    }

    /* Packed → hot! pulsing glow + a flickering flame above the ball. */
    .flameglow {
      position: absolute; inset: -3px; border-radius: 50%;
      animation: glow 0.9s ease-in-out infinite alternate;
    }
    @keyframes glow {
      from { box-shadow: 0 0 6px 1px rgba(255,140,0,0.65); }
      to   { box-shadow: 0 0 14px 5px rgba(255,40,0,0.95); }
    }
    .flame {
      position: absolute; top: -13px; left: 50%; margin-left: -7px;
      font-size: 13px; transform-origin: 50% 100%;
      animation: flicker 0.5s ease-in-out infinite alternate;
    }
    @keyframes flicker {
      from { transform: scale(0.9) rotate(-4deg); opacity: 0.85; }
      to   { transform: scale(1.12) rotate(4deg); opacity: 1; }
    }

    /* Moderate & packed → ball bounces (more action at the court). */
    .bounce { animation: bounce 0.6s ease-in-out infinite; }
    @keyframes bounce {
      0%, 100% { transform: translateY(0); }
      50%      { transform: translateY(-3px); }
    }

    /* Closed / no drop-in right now → recede to a small faded dot so open
       courts (full balls) carry the eye. */
    .dot {
      width: 100%; height: 100%; border-radius: 50%;
      background: #8a97a5; border: 1.5px solid #fff; opacity: 0.6;
      box-shadow: 0 1px 2px rgba(0,0,0,0.3);
    }

    /* Cluster bubble: a count for nearby courts, orange if any are open now,
       grey if none. Tap to zoom in and split it apart. */
    .clus {
      display: flex; align-items: center; justify-content: center;
      border-radius: 50%; font: 700 13px/1 -apple-system, sans-serif;
      color: #fff; border: 2px solid #fff;
      box-shadow: 0 2px 6px rgba(0,0,0,0.35);
    }
    .clus.has-open { background: #ee7d1b; }
    .clus.no-open  { background: #9aa4af; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    var post = function (obj) {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify(obj));
      }
    };

    // No +/- buttons (pinch to zoom, like Google/Apple Maps). zoomSnap 0 keeps
    // pinch/scroll zoom continuous; attribution control hidden for a clean map.
    var map = L.map('map', { zoomControl: false, attributionControl: false, zoomSnap: 0, zoomDelta: 0.4, wheelPxPerZoomLevel: 90 })
      .setView([${SF_CENTER.lat}, ${SF_CENTER.lng}], 12);

    // CARTO Voyager: colorful but clean basemap (green parks, blue water, soft
    // roads) with no mountain/peak symbols. Free, no API key. detectRetina
    // pulls @2x tiles for crisp phone display.
    var tiles = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      maxZoom: 20,
      subdomains: 'abcd',
      detectRetina: true,
      attribution: '&copy; OpenStreetMap &copy; CARTO'
    }).addTo(map);

    // Offline / tile-failure hint: after a few tile fetches fail (no network,
    // CDN down), tell the native layer to show a banner. A single successful
    // tile load clears it. Only posts on transitions, not per tile.
    var tileErrs = 0, offlineShown = false;
    tiles.on('tileerror', function () {
      tileErrs++;
      if (tileErrs >= 3 && !offlineShown) { offlineShown = true; post({ type: 'tiles', ok: false }); }
    });
    tiles.on('tileload', function () {
      tileErrs = 0;
      if (offlineShown) { offlineShown = false; post({ type: 'tiles', ok: true }); }
    });

    // Network status straight from the WebView's browser context — fires the
    // moment connectivity drops, even on a fully-cached map (no pan needed).
    function postNet() { post({ type: 'net', online: navigator.onLine }); }
    window.addEventListener('online', postNet);
    window.addEventListener('offline', postNet);

    var courtLayer = L.layerGroup().addTo(map);
    var markersById = {};
    var userMarker = null;

    // An orange basketball with seams. Faded when open gym isn't running now.
    var BBALL_SVG =
      '<svg viewBox="0 0 100 100" width="100%" height="100%">' +
      '<circle cx="50" cy="50" r="46" fill="#ee7d1b" stroke="#7a3b06" stroke-width="3"/>' +
      '<g fill="none" stroke="#7a3b06" stroke-width="3">' +
      '<line x1="50" y1="6" x2="50" y2="94"/>' +
      '<line x1="6" y1="50" x2="94" y2="50"/>' +
      '<path d="M20,11 C40,33 40,67 20,89"/>' +
      '<path d="M80,11 C60,33 60,67 80,89"/>' +
      '</g></svg>';

    // A blue/white volleyball with curved seams.
    var VBALL_SVG =
      '<svg viewBox="0 0 100 100" width="100%" height="100%">' +
      '<circle cx="50" cy="50" r="46" fill="#f4f6f8" stroke="#1f5fae" stroke-width="3"/>' +
      '<g fill="none" stroke="#1f5fae" stroke-width="3">' +
      '<path d="M50,5 C34,30 28,55 12,79"/>' +
      '<path d="M50,5 C61,34 71,55 92,69"/>' +
      '<path d="M8,54 C36,55 64,69 79,92"/>' +
      '</g></svg>';

    // A red table-tennis paddle with a white ball.
    var PPONG_SVG =
      '<svg viewBox="0 0 100 100" width="100%" height="100%">' +
      '<circle cx="42" cy="40" r="34" fill="#d6322f" stroke="#7a1714" stroke-width="3"/>' +
      '<rect x="36" y="68" width="12" height="26" rx="4" fill="#9c6b3b" stroke="#5e3d1d" stroke-width="3"/>' +
      '<circle cx="78" cy="72" r="10" fill="#f4f6f8" stroke="#7a3b06" stroke-width="3"/>' +
      '</svg>';

    // A shaded lime pickleball: a radial gradient for volume + perforated holes
    // drawn with perspective (each hole's radial axis foreshortens by sqrt(1-d^2),
    // so rim holes squash to thin ellipses). Generated by scratch gen-ball.js and
    // inlined; gradient id "pkg" is shared across markers (all identical → fine).
    var PICKLE_SVG =
      '<svg viewBox="0 0 100 100" width="100%" height="100%"><defs><radialGradient id="pkg" cx="38%" cy="33%" r="72%"><stop offset="0%" stop-color="#e2f770"/><stop offset="45%" stop-color="#c3ea1c"/><stop offset="100%" stop-color="#8bb500"/></radialGradient></defs><circle cx="50" cy="50" r="47" fill="url(#pkg)" stroke="#6f8f00" stroke-width="2"/><g transform="rotate(0.0 50.00 50.00)"><ellipse cx="50.00" cy="50.00" rx="7.00" ry="7.00" fill="#ffffff"/><ellipse cx="50.00" cy="50.00" rx="7.00" ry="7.00" fill="none" stroke="#7c9c1e" stroke-width="0.7" stroke-opacity="0.45"/></g><g transform="rotate(0.0 70.68 50.00)"><ellipse cx="70.68" cy="50.00" rx="4.85" ry="5.40" fill="#ffffff"/><ellipse cx="70.68" cy="50.00" rx="4.85" ry="5.40" fill="none" stroke="#7c9c1e" stroke-width="0.7" stroke-opacity="0.45"/></g><g transform="rotate(60.0 60.34 67.91)"><ellipse cx="60.34" cy="67.91" rx="4.85" ry="5.40" fill="#ffffff"/><ellipse cx="60.34" cy="67.91" rx="4.85" ry="5.40" fill="none" stroke="#7c9c1e" stroke-width="0.7" stroke-opacity="0.45"/></g><g transform="rotate(120.0 39.66 67.91)"><ellipse cx="39.66" cy="67.91" rx="4.85" ry="5.40" fill="#ffffff"/><ellipse cx="39.66" cy="67.91" rx="4.85" ry="5.40" fill="none" stroke="#7c9c1e" stroke-width="0.7" stroke-opacity="0.45"/></g><g transform="rotate(180.0 29.32 50.00)"><ellipse cx="29.32" cy="50.00" rx="4.85" ry="5.40" fill="#ffffff"/><ellipse cx="29.32" cy="50.00" rx="4.85" ry="5.40" fill="none" stroke="#7c9c1e" stroke-width="0.7" stroke-opacity="0.45"/></g><g transform="rotate(240.0 39.66 32.09)"><ellipse cx="39.66" cy="32.09" rx="4.85" ry="5.40" fill="#ffffff"/><ellipse cx="39.66" cy="32.09" rx="4.85" ry="5.40" fill="none" stroke="#7c9c1e" stroke-width="0.7" stroke-opacity="0.45"/></g><g transform="rotate(300.0 60.34 32.09)"><ellipse cx="60.34" cy="32.09" rx="4.85" ry="5.40" fill="#ffffff"/><ellipse cx="60.34" cy="32.09" rx="4.85" ry="5.40" fill="none" stroke="#7c9c1e" stroke-width="0.7" stroke-opacity="0.45"/></g><g transform="rotate(16.0 86.14 60.36)"><ellipse cx="86.14" cy="60.36" rx="2.76" ry="4.60" fill="#ffffff"/><ellipse cx="86.14" cy="60.36" rx="2.76" ry="4.60" fill="none" stroke="#7c9c1e" stroke-width="0.7" stroke-opacity="0.45"/></g><g transform="rotate(48.7 74.80 78.26)"><ellipse cx="74.80" cy="78.26" rx="2.76" ry="4.60" fill="#ffffff"/><ellipse cx="74.80" cy="78.26" rx="2.76" ry="4.60" fill="none" stroke="#7c9c1e" stroke-width="0.7" stroke-opacity="0.45"/></g><g transform="rotate(81.5 55.59 87.18)"><ellipse cx="55.59" cy="87.18" rx="2.76" ry="4.60" fill="#ffffff"/><ellipse cx="55.59" cy="87.18" rx="2.76" ry="4.60" fill="none" stroke="#7c9c1e" stroke-width="0.7" stroke-opacity="0.45"/></g><g transform="rotate(114.2 34.60 84.30)"><ellipse cx="34.60" cy="84.30" rx="2.76" ry="4.60" fill="#ffffff"/><ellipse cx="34.60" cy="84.30" rx="2.76" ry="4.60" fill="none" stroke="#7c9c1e" stroke-width="0.7" stroke-opacity="0.45"/></g><g transform="rotate(146.9 18.50 70.53)"><ellipse cx="18.50" cy="70.53" rx="2.76" ry="4.60" fill="#ffffff"/><ellipse cx="18.50" cy="70.53" rx="2.76" ry="4.60" fill="none" stroke="#7c9c1e" stroke-width="0.7" stroke-opacity="0.45"/></g><g transform="rotate(179.6 12.40 50.24)"><ellipse cx="12.40" cy="50.24" rx="2.76" ry="4.60" fill="#ffffff"/><ellipse cx="12.40" cy="50.24" rx="2.76" ry="4.60" fill="none" stroke="#7c9c1e" stroke-width="0.7" stroke-opacity="0.45"/></g><g transform="rotate(212.4 18.24 29.87)"><ellipse cx="18.24" cy="29.87" rx="2.76" ry="4.60" fill="#ffffff"/><ellipse cx="18.24" cy="29.87" rx="2.76" ry="4.60" fill="none" stroke="#7c9c1e" stroke-width="0.7" stroke-opacity="0.45"/></g><g transform="rotate(245.1 34.16 15.90)"><ellipse cx="34.16" cy="15.90" rx="2.76" ry="4.60" fill="#ffffff"/><ellipse cx="34.16" cy="15.90" rx="2.76" ry="4.60" fill="none" stroke="#7c9c1e" stroke-width="0.7" stroke-opacity="0.45"/></g><g transform="rotate(277.8 55.11 12.75)"><ellipse cx="55.11" cy="12.75" rx="2.76" ry="4.60" fill="#ffffff"/><ellipse cx="55.11" cy="12.75" rx="2.76" ry="4.60" fill="none" stroke="#7c9c1e" stroke-width="0.7" stroke-opacity="0.45"/></g><g transform="rotate(310.5 74.44 21.43)"><ellipse cx="74.44" cy="21.43" rx="2.76" ry="4.60" fill="#ffffff"/><ellipse cx="74.44" cy="21.43" rx="2.76" ry="4.60" fill="none" stroke="#7c9c1e" stroke-width="0.7" stroke-opacity="0.45"/></g><g transform="rotate(343.3 86.01 39.18)"><ellipse cx="86.01" cy="39.18" rx="2.76" ry="4.60" fill="#ffffff"/><ellipse cx="86.01" cy="39.18" rx="2.76" ry="4.60" fill="none" stroke="#7c9c1e" stroke-width="0.7" stroke-opacity="0.45"/></g><ellipse cx="34" cy="30" rx="16" ry="11" fill="#ffffff" opacity="0.18" transform="rotate(-35 34 30)"/></svg>';

    // A yellow-green tennis ball with a white curved seam.
    var TENNIS_SVG =
      '<svg viewBox="0 0 100 100" width="100%" height="100%">' +
      '<circle cx="50" cy="50" r="46" fill="#c6e94b" stroke="#5a7d14" stroke-width="3"/>' +
      '<g fill="none" stroke="#f4f6f8" stroke-width="4">' +
      '<path d="M16,18 C42,34 42,66 16,82"/>' +
      '<path d="M84,18 C58,34 58,66 84,82"/>' +
      '</g></svg>';

    // The ⚽ emoji, matching the sport dial glyph (SportGlyph renders the same).
    var SOCCER_SVG =
      '<svg viewBox="0 0 100 100" width="100%" height="100%">' +
      '<text x="50" y="52" font-size="82" text-anchor="middle" dominant-baseline="central">⚽</text>' +
      '</svg>';

    // The ⚾ emoji (baseball / ball fields), matching the sport dial glyph.
    var BASEBALL_SVG =
      '<svg viewBox="0 0 100 100" width="100%" height="100%">' +
      '<text x="50" y="52" font-size="82" text-anchor="middle" dominant-baseline="central">⚾</text>' +
      '</svg>';

    // A steel dumbbell — the rec-center weight room (a facility view, not a sport).
    var WEIGHT_SVG =
      '<svg viewBox="0 0 100 100" width="100%" height="100%">' +
      '<rect x="36" y="44" width="28" height="12" rx="2" fill="#9aa4af" stroke="#2b3138" stroke-width="3"/>' +
      '<g fill="#5b6570" stroke="#2b3138" stroke-width="3" stroke-linejoin="round">' +
      '<rect x="12" y="28" width="15" height="44" rx="4"/>' +
      '<rect x="28" y="37" width="11" height="26" rx="3"/>' +
      '<rect x="61" y="37" width="11" height="26" rx="3"/>' +
      '<rect x="73" y="28" width="15" height="44" rx="4"/>' +
      '</g></svg>';

    var SPORT_SVG = { basketball: BBALL_SVG, volleyball: VBALL_SVG, pingpong: PPONG_SVG, pickleball: PICKLE_SVG, tennis: TENNIS_SVG, soccer: SOCCER_SVG, baseball: BASEBALL_SVG, weightroom: WEIGHT_SVG };
    var currentSport = 'basketball';
    // A court may carry its own sport (the Favorites view glyphs each pin by the
    // sport it was favorited for); otherwise fall back to the map-wide sport.
    function ballSvg(s) { return SPORT_SVG[s || currentSport] || BBALL_SVG; }
    window.setSport = function (s) { currentSport = s; };

    // Reservation occupancy → halo class. null = not reservable / closed now.
    function bookLevel(pct) {
      if (pct == null) return null;
      if (pct >= 100) return 'full';
      if (pct >= 75) return 'mostly';
      if (pct >= 40) return 'half';
      if (pct > 0) return 'slight';
      return 'none';
    }

    // Decoration based on the latest fresh crowd check-in.
    function crowdDecoration(level) {
      if (level === 'empty') {
        return '<div class="zzz"><span>z</span><span>z</span><span>z</span></div>';
      }
      if (level === 'packed') {
        return '<div class="flameglow"></div><div class="flame">🔥</div>';
      }
      return ''; // moderate / none → no animation
    }

    // Zoomed-out courts are grouped into count bubbles (grid-clustered by screen
    // distance) so dense areas — basketball especially — don't wall off the map;
    // zoom past DECLUSTER_ZOOM and every court shows on its own.
    var allCourts = [];
    var CLUSTER_RADIUS = 55; // px: courts closer than this on screen group together
    var DECLUSTER_ZOOM = 16; // at/after this zoom, always show individual courts

    function individualIcon(c) {
      // Open now → full sport ball with its crowd/booking decorations.
      if (c.open) {
        var size = c.indoor === false ? 22 : 26;
        var ball = '<div class="bball">' + ballSvg(c.sport) + '</div>';
        var level = bookLevel(c.booked);
        var ring = level ? '<div class="bookring bk-' + level + '"></div>' : '';
        // Fully booked hops; otherwise an active crowd bounces.
        var anim = level === 'full' ? ' jump'
          : (c.crowd === 'moderate' || c.crowd === 'packed') ? ' bounce' : '';
        return L.divIcon({
          className: '',
          html: '<div class="ballwrap' + anim + '" style="width:' + size + 'px;height:' + size + 'px">' +
            crowdDecoration(c.crowd) + ring + ball + '</div>',
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2]
        });
      }
      // Closed / no drop-in now → small faded dot.
      return L.divIcon({
        className: '', html: '<div class="dot"></div>',
        iconSize: [13, 13], iconAnchor: [6.5, 6.5]
      });
    }

    function addIndividual(c) {
      var m = L.marker([c.lat, c.lng], { icon: individualIcon(c) });
      m.on('click', function () { post({ type: 'select', id: c.id }); });
      m.addTo(courtLayer);
      markersById[c.id] = m;
    }

    function addCluster(group) {
      var anyOpen = false, sumLat = 0, sumLng = 0, n = group.length;
      for (var i = 0; i < n; i++) {
        if (group[i].open) anyOpen = true;
        sumLat += group[i].lat; sumLng += group[i].lng;
      }
      var d = 26 + Math.min(18, Math.round(Math.log(n) / Math.LN2 * 7)); // grows with count
      var icon = L.divIcon({
        className: '',
        html: '<div class="clus ' + (anyOpen ? 'has-open' : 'no-open') +
          '" style="width:' + d + 'px;height:' + d + 'px">' + n + '</div>',
        iconSize: [d, d], iconAnchor: [d / 2, d / 2]
      });
      var m = L.marker([sumLat / n, sumLng / n], { icon: icon });
      var bounds = L.latLngBounds(group.map(function (c) { return [c.lat, c.lng]; }));
      m.on('click', function () { map.fitBounds(bounds.pad(0.3), { maxZoom: DECLUSTER_ZOOM }); });
      m.addTo(courtLayer);
    }

    function renderMarkers() {
      courtLayer.clearLayers();
      markersById = {};
      if (map.getZoom() >= DECLUSTER_ZOOM) {
        allCourts.forEach(addIndividual);
        return;
      }
      // Bucket courts by a fixed screen-pixel grid (pan-invariant layer points),
      // then render each bucket as a lone court or a cluster bubble.
      var buckets = {};
      allCourts.forEach(function (c) {
        var p = map.latLngToLayerPoint([c.lat, c.lng]);
        var key = Math.round(p.x / CLUSTER_RADIUS) + '_' + Math.round(p.y / CLUSTER_RADIUS);
        (buckets[key] = buckets[key] || []).push(c);
      });
      Object.keys(buckets).forEach(function (k) {
        var g = buckets[k];
        if (g.length === 1) addIndividual(g[0]); else addCluster(g);
      });
    }

    window.setCourts = function (courts) {
      allCourts = courts || [];
      renderMarkers();
    };

    // Re-cluster on zoom (grouping is a function of zoom + geography, so panning
    // needs no rebuild — the geo-anchored markers just move with the map).
    map.on('zoomend', renderMarkers);

    window.setUser = function (lat, lng) {
      if (userMarker) { map.removeLayer(userMarker); }
      userMarker = L.circleMarker([lat, lng], {
        radius: 7,
        color: '#ffffff',
        weight: 3,
        fillColor: '#0a84ff',
        fillOpacity: 1
      }).addTo(map);
      userMarker.bindTooltip('You', { permanent: false });
    };

    window.focusCourt = function (id, lat, lng) {
      // Center the marker in the visible area *above* the court detail card
      // (which slides up over the bottom of the screen) by shifting the map
      // center below the marker, so the pin sits higher on screen. Zoom to the
      // decluster level so the focused court resolves to its own pin, not a bubble.
      var z = DECLUSTER_ZOOM;
      var offsetY = Math.round(map.getSize().y * 0.25);
      var center = map.unproject(map.project([lat, lng], z).add([0, offsetY]), z);
      map.setView(center, z, { animate: true });
      var m = markersById[id];
      if (m) { m.bringToFront(); }
    };

    window.recenter = function (lat, lng) {
      map.setView([lat, lng], 14, { animate: true });
    };

    // Tell React Native the map is ready to receive data, and report the
    // current network status (covers launching while already offline).
    post({ type: 'ready' });
    postNet();
  </script>
</body>
</html>
`;

const CourtMap = forwardRef(function CourtMap(
  { courts, sport = 'basketball', userLocation, onSelectCourt },
  ref
) {
  const { t } = useI18n();
  const webRef = useRef(null);
  const [ready, setReady] = useState(false);
  // Two independent offline signals, OR'd for the banner: browser network status
  // (fires even on a cached map) and a run of failed tile fetches (CDN down).
  const [netOffline, setNetOffline] = useState(false);
  const [tileOffline, setTileOffline] = useState(false);
  const offline = netOffline || tileOffline;

  const inject = useCallback((js) => {
    webRef.current?.injectJavaScript(js + ' true;');
  }, []);

  // Push courts + user location whenever they change (once the map is ready).
  // Set the sport first so markers rebuild with the right ball glyph.
  const pushState = useCallback(() => {
    inject(`window.setSport(${JSON.stringify(sport)}); window.setCourts(${JSON.stringify(courts)});`);
    if (userLocation) {
      inject(
        `window.setUser(${userLocation.lat}, ${userLocation.lng});`
      );
    }
  }, [inject, courts, sport, userLocation]);

  React.useEffect(() => {
    if (ready) pushState();
  }, [ready, pushState]);

  useImperativeHandle(ref, () => ({
    focusCourt(court) {
      inject(`window.focusCourt(${JSON.stringify(court.id)}, ${court.lat}, ${court.lng});`);
    },
    recenter(loc) {
      inject(`window.recenter(${loc.lat}, ${loc.lng});`);
    },
  }));

  const onMessage = useCallback(
    (event) => {
      let msg;
      try {
        msg = JSON.parse(event.nativeEvent.data);
      } catch (e) {
        return;
      }
      if (msg.type === 'ready') {
        setReady(true);
      } else if (msg.type === 'select') {
        onSelectCourt?.(msg.id);
      } else if (msg.type === 'tiles') {
        setTileOffline(!msg.ok);
      } else if (msg.type === 'net') {
        setNetOffline(!msg.online);
      }
    },
    [onSelectCourt]
  );

  return (
    <View style={styles.container}>
      <WebView
        ref={webRef}
        originWhitelist={['*']}
        source={{ html }}
        onMessage={onMessage}
        javaScriptEnabled
        domStorageEnabled
        style={styles.webview}
      />
      {offline && (
        <View style={styles.offline} pointerEvents="none">
          <Ionicons name="cloud-offline-outline" size={15} color="#fff" />
          <Text style={styles.offlineText}>{t('map.offline')}</Text>
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1, overflow: 'hidden' },
  webview: { flex: 1, backgroundColor: '#aadaf0' },
  offline: {
    position: 'absolute',
    bottom: 178,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: 'rgba(13,27,42,0.9)',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  offlineText: { color: '#fff', fontSize: 12, fontWeight: '700' },
});

export default CourtMap;
