/** @type {import('next').NextConfig} */
const nextConfig = {
  // output: 'export' only applies to `next build` (Cloudflare Pages static export).
  // Turbopack dev server cannot generate per-route manifests when this is set,
  // causing an infinite app-paths-manifest.json loop during `next dev`.
  ...(process.env.NODE_ENV === "production"
    ? { output: "export" }
    : {
        // Dev only: clean paths (/feed, /company/<cik>/<tab>) all resolve to the single
        // page, mirroring what public/_redirects does on Cloudflare Pages in production.
        // (Rewrites are ignored by `output: export`, so they are not set there.)
        async rewrites() {
          return { afterFiles: [{ source: "/company/:path*", destination: "/" }, { source: "/:view", destination: "/" }] };
        },
      }),
  images: { unoptimized: true },
};

export default nextConfig;
