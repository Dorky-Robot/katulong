/**
 * Tile Registry
 *
 * Maps tile type names to factory functions. Factories are closures that
 * capture shared dependencies (e.g. terminalPool) and return TilePrototype
 * instances.
 *
 * TilePrototype interface (required):
 *   type: string
 *   mount(container: HTMLElement, ctx: TileContext): void
 *   unmount(): void
 *   focus(): void
 *   blur(): void
 *   resize(): void
 *   getTitle(): string
 *   getIcon(): string       — Phosphor icon name
 *
 * Optional (duck-typed):
 *   serialize(): object
 *   restore(state: object): void
 *   canClose(): boolean
 *
 * TileContext (injected into mount):
 *   tileId: string
 *   sendWs(msg: object): void
 *   onWsMessage(type: string, handler: (msg) => void): unsubscribeFn
 *   setTitle(title: string): void
 *   setIcon(icon: string): void
 */

const registry = new Map();

/**
 * Register a tile type.
 * @param {string} type — unique type identifier (e.g. "terminal", "dashboard")
 * @param {(options: object) => TilePrototype} factory
 */
export function registerTileType(type, factory) {
  if (registry.has(type)) {
    throw new Error(`Tile type "${type}" already registered`);
  }
  registry.set(type, factory);
}

/**
 * Create a tile instance.
 * @param {string} type — registered type name
 * @param {object} options — passed to the factory
 * @returns {TilePrototype}
 */
export function createTile(type, options = {}) {
  const factory = registry.get(type);
  if (!factory) {
    throw new Error(`Unknown tile type: "${type}"`);
  }
  return factory(options);
}
