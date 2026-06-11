import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  clean: true,
  dts: false,
})
