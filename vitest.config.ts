import { defineConfig } from 'vitest/config';
export default defineConfig({test:{include:['packages/**/*.test.ts','apps/**/*.test.ts'],testTimeout:30000,hookTimeout:30000},resolve:{alias:{'@uai/contracts':new URL('./packages/contracts/src/index.ts',import.meta.url).pathname,'@uai/db':new URL('./packages/db/src/index.ts',import.meta.url).pathname}}});
