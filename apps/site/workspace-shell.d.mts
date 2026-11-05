// Types for workspace-shell.mjs (canonical: apps/site).
export const ICON_NAMES: string[];
export function iconPath(name: string): string;
export function iconMarkup(name: string): string;
export function icon(name: string): SVGSVGElement;
export const NAV: ReadonlyArray<{ href: string; label: string }>;
export function activeNav(path: string, options?: { role?: string }): string;
export interface ShellController { setMe(me: unknown): void; setActive(path: string, role?: string): void; destroy(): void }
export function mountShell(host: HTMLElement, options?: { path?: string; role?: string; brandSrc?: string; homeHref?: string }): ShellController;
export interface Poller { now(): Promise<void>; readonly failures: number; stop(): void }
export function poll(run: () => Promise<boolean | void> | boolean | void, options?: { interval?: number; max?: number; jitter?: number; focus?: boolean }): Poller;
