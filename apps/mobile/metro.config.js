const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * The app lives outside the pnpm workspace (React Native's native builds expect a flat
 * node_modules) and reuses the web app's typed API clients, message tables and pure helpers
 * directly from apps/web/src, as docs/architecture/06-frontend.md planned.
 *
 * - Everything resolves dependencies from this app's node_modules, so there is one React.
 * - A few web modules touch browser-only APIs. They are swapped for native twins with the same
 *   exports; every module that imports them gets the twin.
 */
const root = path.resolve(__dirname, '../..');
const web = path.join(root, 'apps/web/src');
const contracts = path.join(root, 'packages/contracts/src');

const twins = new Map(
  [
    ['lib/http.ts', 'lib/http.ts'],
    ['lib/i18n.tsx', 'lib/i18n.tsx'],
    ['features/auth/session.tsx', 'features/auth/session.tsx'],
    ['features/media/api.ts', 'features/media/api.ts'],
  ].map(([from, to]) => [path.join(web, from), path.join(__dirname, 'src', to)]),
);

const contractEntries = {
  '@dorkar/contracts': 'index.ts',
  '@dorkar/contracts/authz': 'authz.ts',
  '@dorkar/contracts/places': 'places.ts',
};

const config = {
  watchFolders: [web, contracts],
  resolver: {
    disableHierarchicalLookup: true,
    nodeModulesPaths: [path.join(__dirname, 'node_modules')],
    resolveRequest(context, name, platform) {
      if (contractEntries[name]) {
        return { type: 'sourceFile', filePath: path.join(contracts, contractEntries[name]) };
      }
      const request = name.startsWith('@web/') ? path.join(web, name.slice(5)) : name;
      const result = context.resolveRequest(context, request, platform);
      const twin = result.type === 'sourceFile' && twins.get(result.filePath);
      return twin ? { type: 'sourceFile', filePath: twin } : result;
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
