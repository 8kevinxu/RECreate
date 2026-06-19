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
    .bball {
      width: 100%;
      height: 100%;
      filter: drop-shadow(0 1px 2px rgba(0,0,0,0.45));
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

    window.setCourts = function (courts) {
      courtLayer.clearLayers();
      markersById = {};
      courts.forEach(function (c) {
        var size = 26;
        var icon = L.divIcon({
          className: '',
          html: '<div class="bball" style="opacity:' + (c.open ? 1 : 0.45) + '">' + BBALL_SVG + '</div>',
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
  { courts, userLocation, onSelectCourt },
  ref
) {
  const webRef = useRef(null);
  const [ready, setReady] = useState(false);

  const inject = useCallback((js) => {
    webRef.current?.injectJavaScript(js + ' true;');
  }, []);

  // Push courts + user location whenever they change (once the map is ready).
  const pushState = useCallback(() => {
    inject(`window.setCourts(${JSON.stringify(courts)});`);
    if (userLocation) {
      inject(
        `window.setUser(${userLocation.lat}, ${userLocation.lng});`
      );
    }
  }, [inject, courts, userLocation]);

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
