/** @type {import('next').NextConfig} */
const nextConfig = {
  // output: 'export' only applies to `next build` (Cloudflare Pages static export).
  // Turbopack dev server cannot generate per-route manifests when this is set,
  // causing an infinite app-paths-manifest.json loop during `next dev`.
  ...(process.env.NODE_ENV === "production" ? { output: "export" } : {}),
  images: { unoptimized: true },
};

export default nextConfig;
