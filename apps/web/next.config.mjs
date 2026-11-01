// The site is static, and only ever static: GitHub Pages serves the export, and it can set no response headers.
export default { output: 'export', basePath: process.env.NEXT_PUBLIC_BASE_PATH, trailingSlash: true, images: { unoptimized: true }, poweredByHeader: false, productionBrowserSourceMaps: false };
