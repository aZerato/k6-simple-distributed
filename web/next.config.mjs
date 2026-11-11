// Build en export statique : le dossier `out/` est ensuite servi par
// l'orchestrateur Express (mêmes origines pour HTTP + Socket.io).
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export'
};

export default nextConfig;
