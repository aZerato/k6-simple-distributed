// Static export build: the `out/` folder is then served by the
// Express orchestrator (same origin for HTTP + Socket.io).
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export'
};

export default nextConfig;
