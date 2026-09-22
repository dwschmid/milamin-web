import { defineConfig } from 'vite';
import { coopCoep, distributionNotices, sharedAliases, sharedConfig } from '../../vite.shared';
import { siteChrome } from '../milamin/site-chrome';

export default defineConfig({
  root: __dirname,
  ...sharedConfig,
  // FOLDER is an app of the MilAMin site: same header, menu and footer, served
  // at milamin/folder/ (root = '../' points the chrome's links at MilAMin)
  plugins: [coopCoep(), siteChrome({ root: '../', page: 'folder/' }), distributionNotices()],
  resolve: { alias: sharedAliases },
});
