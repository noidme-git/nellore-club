/** @type {import('next').NextConfig} */

// Static export. Every page is prerendered to HTML at build time and served by
// Cloudflare Workers Static Assets, so there is no SSR cost and no cold start.
//
// Tournament data lives in D1 and changes during a live event, so it cannot be
// baked in at build time. Pages that show it (a bracket, the leaderboard) ship
// as a shell and fetch from the Worker API on the client. The Worker rewrites
// the clean dynamic URLs (/t/<slug>, /admin/*) onto those shells -- static
// export cannot prerender a page per tournament.
const nextConfig = {
  output: 'export',

  // There is a stray package-lock.json in the home directory, so Next infers
  // ~/ as the workspace root and warns. Pin it to this project.
  outputFileTracingRoot: import.meta.dirname,

  // Static hosting has no image optimizer.
  images: { unoptimized: true },

  // Emit /path/index.html rather than /path.html, so the Worker can serve a
  // clean URL without a rewrite table.
  trailingSlash: true,

  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
