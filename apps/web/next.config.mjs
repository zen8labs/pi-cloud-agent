/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The protocol package ships TypeScript rather than a build output, so Next
  // compiles it like app code. That is what lets the dashboard and the
  // controller share one definition of a run instead of restating it.
  transpilePackages: ["@pi-cloud-agent/protocol"],
};
export default nextConfig;
