interface ImportMetaEnv {
  /**
   * Public Mapbox token (pk.), inlined at build time by vite.config.ts. Empty in CI, unit tests and
   * screenshots, where RouteMap draws the route as a sketch instead of loading Mapbox.
   */
  readonly VITE_MAPBOX_TOKEN?: string;
}
