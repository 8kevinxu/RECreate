import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

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
      width: 100%;
      height: 100%;
      filter: drop-shadow(0 1px 2px rgba(0,0,0,0.45));
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

    var map = L.map('map', { zoomControl: true })
      .setView([${SF_CENTER.lat}, ${SF_CENTER.lng}], 12);

    // CARTO Voyager: colorful but clean basemap (green parks, blue water, soft
    // roads) with no mountain/peak symbols. Free, no API key. detectRetina
    // pulls @2x tiles for crisp phone display.
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      maxZoom: 20,
      subdomains: 'abcd',
      detectRetina: true,
      attribution: '&copy; OpenStreetMap &copy; CARTO'
    }).addTo(map);

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

    // A teal pickleball paddle with a yellow holed ball.
    var PICKLE_SVG =
      '<svg viewBox="0 0 100 100" width="100%" height="100%">' +
      '<rect x="14" y="8" width="56" height="60" rx="14" fill="#1f9e8a" stroke="#0c5a4e" stroke-width="3"/>' +
      '<rect x="34" y="64" width="14" height="28" rx="4" fill="#9c6b3b" stroke="#5e3d1d" stroke-width="3"/>' +
      '<circle cx="78" cy="74" r="11" fill="#f4d11e" stroke="#7a6a06" stroke-width="3"/>' +
      '<g fill="#7a6a06"><circle cx="74" cy="70" r="1.6"/><circle cx="82" cy="71" r="1.6"/><circle cx="78" cy="78" r="1.6"/></g>' +
      '</svg>';

    var SPORT_SVG = { basketball: BBALL_SVG, volleyball: VBALL_SVG, pingpong: PPONG_SVG, pickleball: PICKLE_SVG };
    var currentSport = 'basketball';
    function ballSvg() { return SPORT_SVG[currentSport] || BBALL_SVG; }
    window.setSport = function (s) { currentSport = s; };

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

    window.setCourts = function (courts) {
      courtLayer.clearLayers();
      markersById = {};
      courts.forEach(function (c) {
        var size = 26;
        var ball = '<div class="bball" style="opacity:' + (c.open ? 1 : 0.45) + '">' + ballSvg() + '</div>';
        var bounce = (c.crowd === 'moderate' || c.crowd === 'packed') ? ' bounce' : '';
        var icon = L.divIcon({
          className: '',
          html: '<div class="ballwrap' + bounce + '">' + crowdDecoration(c.crowd) + ball + '</div>',
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2]
        });
        var m = L.marker([c.lat, c.lng], { icon: icon });
        m.on('click', function () { post({ type: 'select', id: c.id }); });
        m.addTo(courtLayer);
        markersById[c.id] = m;
      });
    };

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
      map.setView([lat, lng], 15, { animate: true });
      var m = markersById[id];
      if (m) { m.bringToFront(); }
    };

    window.recenter = function (lat, lng) {
      map.setView([lat, lng], 14, { animate: true });
    };

    // Tell React Native the map is ready to receive data.
    post({ type: 'ready' });
  </script>
</body>
</html>
`;

const CourtMap = forwardRef(function CourtMap(
  { courts, sport = 'basketball', userLocation, onSelectCourt },
  ref
) {
  const webRef = useRef(null);
  const [ready, setReady] = useState(false);

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
    </View>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1, overflow: 'hidden' },
  webview: { flex: 1, backgroundColor: '#aadaf0' },
});

export default CourtMap;
