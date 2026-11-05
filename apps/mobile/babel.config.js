module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // zod v4 ships `export * as`, which the preset leaves untransformed.
  plugins: ['@babel/plugin-transform-export-namespace-from'],
};
