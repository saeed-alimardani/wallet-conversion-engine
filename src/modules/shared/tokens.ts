/**
 * DI injection tokens for shared-kernel ports. Symbols (not strings) to avoid
 * accidental collisions and to make "go to definition" work from injection sites.
 */
export const CLOCK = Symbol('CLOCK');
export const ID_GENERATOR = Symbol('ID_GENERATOR');
