import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {App, serve as serveStatic} from 'zipadee';
import {serve as serveJs} from '@zipadee/javascript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const siteDir = path.join(__dirname, '_site');
const rootDir = path.resolve(__dirname, '../..'); // Monorepo root to access node_modules
const relativeSiteDir = path.relative(rootDir, siteDir); // 'packages/website/_site'

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

const app = new App();

// Middleware for rewriting bare JS imports
app.use(
  serveJs({
    root: rootDir,
    base: relativeSiteDir,
  }),
);

// Serve built site files
app.use(serveStatic(siteDir));

app.listen(port).then(() => {
  console.log(`🚀 Zipadee dev server running at http://localhost:${port}`);
  console.log(`Serving static site from: ${siteDir}`);
  console.log(`Rewriting bare module specifiers via @zipadee/javascript`);
});
