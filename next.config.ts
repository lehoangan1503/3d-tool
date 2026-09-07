import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    // CMYK surface images can exceed 10MB — raise the API route body limit.
    proxyClientMaxBodySize: 200 * 1024 * 1024, // 200MB — video studio xuat mp4 ~50-150MB
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "supa-api.top",
        pathname: "/storage/v1/object/public/**",
      },
    ],
  },
};

export default nextConfig;
