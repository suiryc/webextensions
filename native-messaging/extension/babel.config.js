// See: https://github.com/mochajs/mocha-examples/tree/master/packages/babel
// See: https://github.com/babel/babel/issues/9849#issuecomment-592668815
// See: https://babeljs.io/docs/en/babel-preset-env#targetsesmodules
// See: https://babeljs.io/docs/en/babel-preset-env#usebuiltins
module.exports = (api) => {
  // Cache configuration is a required option
  api.cache(false);

  const presets = [
    [
      "@babel/preset-env",
      {
        targets: {
          esmodules: true,
        },
        useBuiltIns: false
      }
    ]
  ];

  return { presets };
};