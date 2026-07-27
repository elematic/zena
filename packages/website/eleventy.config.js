import syntaxHighlight from '@11ty/eleventy-plugin-syntaxhighlight';

export default (eleventyConfig) => {
  // Syntax highlighting for code blocks
  eleventyConfig.addPlugin(syntaxHighlight);

  // Pass through static assets
  eleventyConfig.addPassthroughCopy('src/css');
  eleventyConfig.addPassthroughCopy('src/images');
  eleventyConfig.addPassthroughCopy({
    '../website-client/lib': 'js',
    '../language-service/lsp.wasm': 'wasm/lsp.wasm',
  });

  return {
    dir: {
      input: 'src',
      output: '_site',
      includes: '_includes',
      layouts: '_layouts',
    },
    htmlTemplateEngine: 'njk',
    markdownTemplateEngine: 'njk',
  };
};
