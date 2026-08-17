/**
 * `babel-preset-expo` is not optional here.
 *
 * expo-router's entry does `require.context(process.env.EXPO_ROUTER_APP_ROOT)`,
 * and that variable is injected at build time by this preset's router plugin.
 * With no babel config the preset never runs, the variable is undefined, and
 * Metro fails with "First argument of `require.context` should be a string" —
 * which points at expo-router's internals rather than at the missing config.
 */
module.exports = function (api) {
  api.cache(true)
  return {
    presets: ['babel-preset-expo'],
  }
}
