// The libraries copied as they are into vendor/ (marked, DOMPurify and
// GitHub's octicons), bundled with the pages: only what the dashboard uses.
declare module '*/vendor/octicons.js' {
  export const OCTICON: Record<string, string[]>;
}

declare module '*/vendor/marked.esm.js' {
  export const marked: { parse(text: string, options: { gfm: boolean; breaks: boolean }): string };
}

declare module '*/vendor/purify.esm.js' {
  const DOMPurify: {
    sanitize(html: string, options: { FORBID_TAGS: string[]; ALLOWED_URI_REGEXP: RegExp }): string;
    addHook(hook: 'afterSanitizeAttributes', fn: (node: Element) => void): void;
  };
  export default DOMPurify;
}
