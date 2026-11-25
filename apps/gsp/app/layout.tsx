import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Georgia State Pursuit — Vehicle Physics Demonstrator',
  description: 'A browser police-pursuit physics demonstrator on the OpenRoad Dynamics vehicle core, Rapier, Glass Dynamics and Street Dynamics. Humorous, fictional, entertainment only.',
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0b0f16' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
