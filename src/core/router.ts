/**
 * Minimal path router.
 *
 * Two routes only: the home grid at `/`, and one page per module at
 * `/m/<module-id>`. Real paths rather than hashes, because the Worker's
 * `not_found_handling: "single-page-application"` already serves index.html for
 * any unmatched path, so a deep link works on first load and not only after a
 * client-side navigation.
 */

export type Route = { name: 'home' } | { name: 'module'; id: string };

export function parseRoute(pathname: string): Route {
  const match = /^\/m\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  if (match?.[1] !== undefined) return { name: 'module', id: match[1] };
  return { name: 'home' };
}

export function routePath(route: Route): string {
  return route.name === 'home' ? '/' : `/m/${route.id}`;
}

export class Router {
  #onChange: (route: Route) => void;
  #onPop: () => void;

  constructor(onChange: (route: Route) => void) {
    this.#onChange = onChange;
    this.#onPop = () => this.#onChange(this.current);
    window.addEventListener('popstate', this.#onPop);
  }

  get current(): Route {
    return parseRoute(window.location.pathname);
  }

  navigate(route: Route): void {
    const path = routePath(route);
    if (path === window.location.pathname) return;
    window.history.pushState(null, '', path);
    // A view change is a page change: start at the top, as a real navigation
    // would, rather than leaving the reader wherever they happened to scroll.
    window.scrollTo(0, 0);
    this.#onChange(route);
  }

  /** Intercept same-origin link clicks so navigation stays client-side. */
  bindLinks(root: HTMLElement): void {
    root.addEventListener('click', (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as HTMLElement).closest('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (href === null || !href.startsWith('/')) return;
      if (anchor.target === '_blank') return;
      event.preventDefault();
      this.navigate(parseRoute(href));
    });
  }

  destroy(): void {
    window.removeEventListener('popstate', this.#onPop);
  }
}
