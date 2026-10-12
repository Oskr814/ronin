import { describe, it, expect } from 'vitest';
import { absoluteUrl, authStatePath, contextOptions, fillCredentials } from './app-browser.js';
import type { AppSession } from './app-runtime.js';

describe('absoluteUrl', () => {
  it('joins a path to the base URL and leaves an absolute URL alone', () => {
    expect(absoluteUrl('http://127.0.0.1:5173', '/login')).toBe('http://127.0.0.1:5173/login');
    expect(absoluteUrl('http://127.0.0.1:5173', 'login')).toBe('http://127.0.0.1:5173/login');
    expect(absoluteUrl('http://127.0.0.1:5173', 'https://sso.example.com/x')).toBe('https://sso.example.com/x');
  });
});

describe('fillCredentials', () => {
  it('fills the user placeholders and nothing else', () => {
    const user = { role: 'Sales', username: 'sales@x', password: 'p4ss' };
    expect(fillCredentials('{{username}}:{{password}}:{{dir}}', user)).toBe('sales@x:p4ss:{{dir}}');
  });
});

describe('contextOptions', () => {
  it('turns a mobile viewport into a touch, high-density context', () => {
    expect(contextOptions({ width: 390, height: 844, isMobile: true })).toEqual({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
    });
    expect(contextOptions({ width: 1440, height: 900 })).toEqual({ viewport: { width: 1440, height: 900 } });
  });
});

describe('authStatePath', () => {
  it('keeps one file per role, with a filesystem-safe name', () => {
    const session = { stateDir: '/w/.ronin-app' } as AppSession;
    expect(authStatePath(session, 'Sales')).toBe('/w/.ronin-app/auth/Sales.json');
    expect(authStatePath(session, 'Jefe de bodega')).toBe('/w/.ronin-app/auth/Jefe_de_bodega.json');
  });
});
