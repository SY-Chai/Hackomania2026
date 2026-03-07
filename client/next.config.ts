import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["mapbox-gl"],
  turbopack: {},
};

export default nextConfig;
