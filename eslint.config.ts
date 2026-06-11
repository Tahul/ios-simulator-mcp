import antfu from '@antfu/eslint-config'

export default antfu({
  type: 'app',
  typescript: true,
  jsonc: false,
  yaml: false,
  markdown: false,
  ignores: ['dist', 'node_modules'],
  rules: {
    'no-console': 'off',
    'node/prefer-global/process': 'off',
    'style/max-statements-per-line': ['error', { max: 3 }],
  },
})
