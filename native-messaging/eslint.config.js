import js from '@eslint/js';
import globals from "globals";

export default [
  // Apply ESLint's default recommended rules for general syntax safety
  js.configs.recommended,

  // Global configuration.
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module'
    },
    rules: {
      // When needed, use warnings instead of hard errors, for easier debugging
      // and testing.

      // No unused variables.
      'no-unused-vars': ['warn', {
        // Check all variables.
        'vars': 'all', 
        // Ignore unused method arguments.
        'args': 'none', 
        // Ignore unused sibling variables when "rest destructuring" is used.
        'ignoreRestSiblings': true 
      }],
      
      // Strict equality checking preferences.
      // Smartly apply, which ignores comparing:
      //  - literal values
      //  - typeof
      //  - null: 'myvar == null' is a useful pattern working with undefined
      'eqeqeq': ['warn', 'smart'],
      
      // Prefer 'let'/'const' over 'var'.
      'no-var': 'warn',

      // Prefer 'const' over 'let'.
      // Ignore when at least one variable cannot be 'const' in declaration with
      // multiple variables.
      'prefer-const': ['warn', { 'destructuring': 'all' }]
    }
  },

  // Overrides for browser context.
  {
    files: ['extension/src/**/*.js'],
    ignores: ['extension/src/unit-test/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.webextensions
      }
    }
  },

  // Overrides for Node.js context.
  {
    files: [
      'gulpfile.js',
      'app/src/*.js',
      'extension/src/unit-test/*.js'
    ],
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  },

  // Overrides for content scripts: the main content script do define global
  // variables, for sub-scripts.
  {
    files: ['extension/src/content-script/*.js'],
    ignores: ['extension/src/content-script/content-script.js'],
    languageOptions: {
      globals: {
        webext: 'readonly',
        windowId: 'readonly',
        tabId: 'readonly',
        frameId: 'readonly',
        notifDefaults: 'readonly'
      }
    }
  },

  // Overrides for unit tests.
  {
    files: ['extension/src/unit-test/*.js'],
    languageOptions: {
      globals: {
        ...globals.mocha
      }
    }
  }

];
