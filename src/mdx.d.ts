// Lets TypeScript treat `import Article from './x.mdx'` as a React component.
// immediately.run renders .mdx natively; the Vite MDX plugin (vite.config.ts)
// keeps local build/lint in sync. Use .mdx ONLY for long-form prose, never for
// structured/repeated data (that belongs in src/data/*.ts).
declare module '*.mdx' {
  import type { ComponentType } from 'react';
  const MDXComponent: ComponentType;
  export default MDXComponent;
}
