/** Build-time modules are trusted application code, never uploaded plugins. */
export interface PageDefinition {
  id: string;
  label: string;
  description?: string;
}
export interface ModuleDefinition<P extends PageDefinition = PageDefinition> {
  id: string;
  label: string;
  pages: readonly P[];
}
const identifier = /^[a-z][a-z0-9-]{0,63}$/;
export function pageKey(moduleId: string, pageId: string) {
  if (!identifier.test(moduleId) || !identifier.test(pageId)) throw new Error('Invalid admin module or page identifier');
  return `app.${moduleId}.${pageId}`;
}
export function registerModules<P extends PageDefinition>(modules: readonly ModuleDefinition<P>[]) {
  const registered = new Map<string, P>();
  const ids = new Set<string>();
  for (const module of modules) {
    if (!identifier.test(module.id) || ids.has(module.id) || !module.label.trim() || !module.pages.length) throw new Error('Invalid or duplicate admin module');
    ids.add(module.id);
    for (const page of module.pages) {
      const key = pageKey(module.id, page.id);
      if (registered.has(key) || !page.label.trim()) throw new Error('Invalid or duplicate admin page');
      registered.set(key, page);
    }
  }
  return registered;
}
