import tseslint from "typescript-eslint";
import astro from "eslint-plugin-astro";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: [
      ".astro/**",
      ".private/**",
      ".venv-photo-calibration/**",
      ".vercel/**",
      "dist/**",
      "node_modules/**",
      "playwright-report/**",
      "public/media/**",
      "src/content/photography/iCloud Photos/**",
      "src/data/**",
      "test-results/**",
    ],
  },
  ...tseslint.configs.recommended,
  ...astro.configs["flat/recommended"],
  {
    files: ["**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.flat.recommended.rules,
  },
];
