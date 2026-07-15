// Pure-JS QR code rendered as plain Views (no native module, no SVG lib —
// keeps it OTA-safe and identical on web). Encoding comes from the zero-dep
// qrcode-generator package; rows are run-length merged so a 29×29 code is a
// few hundred Views, not ~850.
import React, { useMemo } from 'react';
import { View } from 'react-native';
import qrcodegen from 'qrcode-generator';

const make = qrcodegen.default || qrcodegen;

export default function QRCode({ value, size = 152, accessibilityLabel }) {
  const grid = useMemo(() => {
    try {
      const qr = make(0, 'M'); // type 0 = pick the smallest version that fits
      qr.addData(value);
      qr.make();
      const n = qr.getModuleCount();
      const rows = [];
      for (let r = 0; r < n; r++) {
        const runs = [];
        for (let c = 0; c < n; ) {
          const dark = qr.isDark(r, c);
          let len = 1;
          while (c + len < n && qr.isDark(r, c + len) === dark) len++;
          runs.push({ dark, len });
          c += len;
        }
        rows.push(runs);
      }
      return { n, rows };
    } catch {
      return null; // value too long for a QR — render nothing
    }
  }, [value]);

  if (!grid) return null;
  const quiet = 3; // white quiet-zone modules around the code (spec minimum is 4 incl. edge)
  const cell = size / (grid.n + quiet * 2);

  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      style={{
        width: size,
        height: size,
        padding: quiet * cell,
        backgroundColor: '#fff',
        borderRadius: 8,
      }}
    >
      {grid.rows.map((runs, r) => (
        <View key={r} style={{ flexDirection: 'row', height: cell }}>
          {runs.map((run, i) => (
            <View
              key={i}
              style={{
                width: run.len * cell,
                // dark runs bleed a hair into the next row so float rounding
                // can't open white hairlines between rows
                height: run.dark ? cell + 0.5 : cell,
                backgroundColor: run.dark ? '#0d1b2a' : 'transparent',
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}
