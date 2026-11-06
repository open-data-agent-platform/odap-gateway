import type { NextConfig } from "next";
import { normalizeGatewayBasePath } from "./lib/gateway-path";

const nextConfig: NextConfig = {
  output: "export",
  basePath: normalizeGatewayBasePath(process.env.NEXT_PUBLIC_GATEWAY_BASE_PATH),
  eslint: {
    ignoreDuringBuilds: true
  }
};

export default nextConfig;
