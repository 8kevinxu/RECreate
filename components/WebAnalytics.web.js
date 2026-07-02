// Web variant: mounts Vercel Analytics. Use the framework-agnostic /react entry
// (this is a react-native-web SPA, NOT Next.js — /next depends on next/navigation
// and would fail here). Only collects data when served from Vercel.
import React from 'react';
import { Analytics } from '@vercel/analytics/react';

export default function WebAnalytics() {
  return <Analytics />;
}
