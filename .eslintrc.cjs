module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:react-hooks/recommended',
  ],
  plugins: ['react-hooks'],
  rules: {
    'no-undef': 'error',
    'no-unused-vars': ['warn', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
  },
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
  },
}
