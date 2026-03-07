import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["mapbox-gl"],
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
