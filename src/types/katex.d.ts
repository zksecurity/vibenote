declare module 'katex' {
  type KatexOptions = {
    displayMode?: boolean;
    throwOnError?: boolean;
    errorColor?: string;
    macros?: Record<string, string>;
  };

  const katex: {
    renderToString: (tex: string, options?: KatexOptions) => string;
  };

  export type { KatexOptions };
  export default katex;
}
