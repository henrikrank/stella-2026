/**
 * Resolves a runtime asset path against the deployment's base URL.
 *
 * On GitHub Pages the site is served from /<repo>/, not from the domain root,
 * so bare "/assets/..." paths 404 there while working fine in dev. Vite fills
 * in BASE_URL ("/" locally, "/<repo>/" in the deployed build).
 */
export function asset(path) {
  return `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`;
}
