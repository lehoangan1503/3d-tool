import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
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
