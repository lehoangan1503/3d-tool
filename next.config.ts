import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  images: {
    remotePatterns: [
      {
        protocol: "http",
        hostname: "5.223.48.44",
        port: "8000",
        pathname: "/storage/v1/object/public/**",
      },
    ],
  },
};

export default nextConfig;
