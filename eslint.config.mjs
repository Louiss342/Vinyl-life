import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
import tseslint from 'typescript-eslint';

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    ignores: [
      'node_modules/**',
      'tmp/**',
      'server/**',
      'scripts/**',
      'main.js',
      'server.js',
      'src/core/gateway-bundle.ts',
      'src/core/style-bundle.ts',
    ],
  },
  {
    // 只对 TS 生效：这里的规则几乎都要类型信息（projectService 只认 TS 源码），
    // 漏到 package.json 上会让 no-base-to-string 在 lint 时抛「requires type information」——
    // 而 --quiet 把这条内部错误一起吞掉，等于 package.json 那一整块规则（obsidianmd 推荐配置里
    // 给它备了 62 条）从来没真正跑过。
    files: ['**/*.ts'],
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      obsidianmd,
    },
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.mjs'],
        },
      },
    },
    rules: {
      '@typescript-eslint/no-base-to-string': 'warn',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      'no-empty': 'warn',
      'no-useless-escape': 'warn',
      'obsidianmd/rule-custom-message': 'warn',
      'prefer-spread': 'warn',
    },
  },
  // 依赖方向（第一道闸，与 scripts/deps-direction.test.cjs 互补）：
  // lint 挡「新写的直接 import」，测试挡「间接传导」—— 两者都要。
  // 用 warn 不用 error：存量 19 个越界文件会立刻刷屏，error 会让 npm run lint 直接失败
  // （CI 红 = 门禁被关）。等越界降到 ≤15 再逐个文件开 error，或改用 overrides 精确豁免基线文件。
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['warn', {
        paths: [
          { name: 'obsidian', message: 'src/core 不得依赖 obsidian（见执行手册 T0.1）。新需求请走端口接口。' },
          { name: 'electron', message: 'src/core 不得依赖 electron。' },
        ],
        patterns: [
          { group: ['../main', '../util', '../views/*'], message: 'src/core 不得反向依赖宿主层（会绕过依赖方向闸门）。' },
        ],
      }],
    },
  },
]);
