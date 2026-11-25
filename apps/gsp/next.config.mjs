// Georgia State Pursuit — static export served by the site at /gsp (no server at run time).
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  basePath: '/gsp',
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: false,
  productionBrowserSourceMaps: false,
  env: { NEXT_PUBLIC_BASE_PATH: '/gsp' },
  agentRules: false,
};
export default nextConfig;
