// The site is static, and only ever static: GitHub Pages serves the export, and it can set no response headers.
// NEXT_BUILD_CPUS caps the static-generation workers on a machine short of memory; unset, Next decides.
const cpus = Number(process.env.NEXT_BUILD_CPUS);
export default { output: 'export', basePath: process.env.NEXT_PUBLIC_BASE_PATH, trailingSlash: true, images: { unoptimized: true }, poweredByHeader: false, productionBrowserSourceMaps: false, ...(cpus > 0 ? { experimental: { cpus } } : {}) };
