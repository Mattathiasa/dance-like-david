// House rules: plain ES modules, no build step. The style is in AGENTS.md (2 spaces, no
// semicolons) and enforced by hand, so this config only covers what a human eye misses.
const browser = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly',
  console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
  clearInterval: 'readonly', requestAnimationFrame: 'readonly', performance: 'readonly',
  fetch: 'readonly', WebSocket: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly',
  CustomEvent: 'readonly', EventTarget: 'readonly', structuredClone: 'readonly', devicePixelRatio: 'readonly',
  AudioContext: 'readonly', webkitAudioContext: 'readonly', DeviceMotionEvent: 'readonly',
  WakeLock: 'readonly', screen: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
  cancelAnimationFrame: 'readonly', confirm: 'readonly', alert: 'readonly', MediaRecorder: 'readonly',
  MediaStream: 'readonly', requestIdleCallback: 'readonly', queueMicrotask: 'readonly',
  Blob: 'readonly', ArrayBuffer: 'readonly', Audio: 'readonly', HTMLElement: 'readonly', Image: 'readonly',
};
const node = {
  process: 'readonly', Buffer: 'readonly', console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly', setImmediate: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
  performance: 'readonly', fetch: 'readonly', structuredClone: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
  __dirname: 'readonly', __filename: 'readonly', exports: 'writable', globalThis: 'readonly',
};

export default [
  { ignores: ['node_modules/**', 'data/**', 'certs/**', 'tests/screenshots/**'] },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...node, ...browser },
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
      'no-implicit-globals': 'error',
      'no-return-await': 'error',
      'no-throw-literal': 'error',
      'no-async-promise-executor': 'error',
      'no-await-in-loop': 'off',
      // Express handlers and the module-level singletons in this server read as false positives
      'require-atomic-updates': 'off',
      'no-cond-assign': 'error',
      'no-constant-condition': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-fallthrough': 'error',
      'no-self-compare': 'error',
      'no-sparse-arrays': 'error',
      'no-unreachable': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: { globals: { ...node, ...browser, WebSocket: 'readonly' } },
  },
];
